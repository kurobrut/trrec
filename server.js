const express = require("express");
const { Pool } = require("pg");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 3000);

const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN || "";

const TELEGRAM_CHAT_ID =
    process.env.TELEGRAM_CHAT_ID || "";

const CHECK_INTERVAL =
    Number(process.env.CHECK_INTERVAL || 30000);

const BATCH_SIZE =
    Number(process.env.BATCH_SIZE || 50);

const BATCH_DELAY =
    Number(process.env.BATCH_DELAY || 500);


// ============================================================
// DATABASE
// ============================================================

if (!DATABASE_URL) {
    console.error("DATABASE_URL missing");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


// ============================================================
// PRESENCE TYPES
// ============================================================

const PRESENCE_TYPES = {
    0: "Offline",
    1: "Online",
    2: "In Game",
    3: "In Studio",
    4: "Invisible"
};


// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkArray(array, size) {
    const chunks = [];

    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }

    return chunks;
}

function formatTime(date = new Date()) {
    return new Intl.DateTimeFormat("en-PH", {
        timeZone: "Asia/Manila",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
    }).format(new Date(date));
}

function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts = [];

    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (secs || !parts.length) parts.push(`${secs}s`);

    return parts.join(" ");
}


// ============================================================
// DATABASE SETUP
// ============================================================

async function setupDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tracked_targets (
            user_id BIGINT PRIMARY KEY,
            username TEXT,
            display_name TEXT,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tracked_players (
            user_id BIGINT PRIMARY KEY,
            username TEXT,
            display_name TEXT,

            presence_type INTEGER NOT NULL DEFAULT 0,
            presence_name TEXT,

            game_name TEXT,
            place_id BIGINT,
            root_place_id BIGINT,
            universe_id BIGINT,
            game_id TEXT,
            last_location TEXT,

            online_since TIMESTAMPTZ,
            game_started_at TIMESTAMPTZ,
            last_seen TIMESTAMPTZ,

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS game_sessions (
            id BIGSERIAL PRIMARY KEY,

            user_id BIGINT NOT NULL,
            username TEXT,

            game_name TEXT,
            place_id BIGINT,
            root_place_id BIGINT,
            universe_id BIGINT,
            game_id TEXT,

            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at TIMESTAMPTZ,
            duration_seconds BIGINT,

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS presence_history (
            id BIGSERIAL PRIMARY KEY,

            user_id BIGINT NOT NULL,
            username TEXT,

            event_type TEXT NOT NULL,

            presence_type INTEGER,
            presence_name TEXT,

            game_name TEXT,

            place_id BIGINT,
            root_place_id BIGINT,
            universe_id BIGINT,
            game_id TEXT,

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    console.log("Database ready");
}


// ============================================================
// ROBLOX USERS API
// ============================================================

async function getUsers(userIds) {

    if (!userIds.length) return new Map();

    const response = await fetch(
        "https://users.roblox.com/v1/users",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userIds,
                excludeBannedUsers: false
            })
        }
    );

    if (!response.ok) {
        throw new Error(
            `Users API failed: ${response.status}`
        );
    }

    const data = await response.json();

    const map = new Map();

    for (const user of data.data || []) {
        map.set(Number(user.id), user);
    }

    return map;
}


// ============================================================
// USERNAME -> USER ID
// ============================================================

async function getUserByUsername(username) {

    const response = await fetch(
        "https://users.roblox.com/v1/usernames/users",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                usernames: [username],
                excludeBannedUsers: false
            })
        }
    );

    if (!response.ok) {
        throw new Error(
            `Username lookup failed: ${response.status}`
        );
    }

    const data = await response.json();

    return data.data?.[0] || null;
}


// ============================================================
// PRESENCE API
// ============================================================

async function getPresence(userIds) {

    const response = await fetch(
        "https://presence.roblox.com/v1/presence/users",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userIds
            })
        }
    );

    if (!response.ok) {
        throw new Error(
            `Presence API failed: ${response.status}`
        );
    }

    const data = await response.json();

    return data.userPresences || [];
}


// ============================================================
// GAME INFO
// ============================================================

async function getGameInfo(universeId) {

    if (!universeId) return null;

    try {

        const response = await fetch(
            `https://games.roblox.com/v1/games?universeIds=${universeId}`
        );

        if (!response.ok) return null;

        const data = await response.json();

        return data.data?.[0] || null;

    } catch {
        return null;
    }
}


// ============================================================
// TRACKED LIST
// ============================================================

async function getTrackedUsers() {

    const result = await pool.query(`
        SELECT user_id
        FROM tracked_targets
        WHERE enabled = TRUE
        ORDER BY added_at ASC
    `);

    return result.rows.map(
        row => Number(row.user_id)
    );
}


// ============================================================
// NOTIFICATIONS
// ============================================================

async function sendDiscord(title, description, color = 0x5865F2) {

    if (!DISCORD_WEBHOOK) return;

    try {

        await fetch(DISCORD_WEBHOOK, {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                embeds: [
                    {
                        title,
                        description,
                        color,
                        timestamp: new Date().toISOString()
                    }
                ]
            })
        });

    } catch (err) {

        console.error(
            "Discord error:",
            err.message
        );
    }
}


async function sendTelegram(message) {

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)
        return;

    try {

        await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: "HTML",
                    disable_web_page_preview: true
                })
            }
        );

    } catch (err) {

        console.error(
            "Telegram error:",
            err.message
        );
    }
}


async function notify(
    title,
    discordMessage,
    telegramMessage,
    color
) {

    await Promise.allSettled([
        sendDiscord(
            title,
            discordMessage,
            color
        ),

        sendTelegram(
            telegramMessage
        )
    ]);
}


// ============================================================
// HISTORY
// ============================================================

async function saveHistory({
    userId,
    username,
    eventType,
    presenceType,
    gameName,
    placeId,
    rootPlaceId,
    universeId,
    gameId
}) {

    await pool.query(
        `
        INSERT INTO presence_history
        (
            user_id,
            username,
            event_type,

            presence_type,
            presence_name,

            game_name,

            place_id,
            root_place_id,
            universe_id,

            game_id
        )

        VALUES
        (
            $1,$2,$3,
            $4,$5,
            $6,
            $7,$8,$9,
            $10
        )
        `,
        [
            userId,
            username,
            eventType,

            presenceType,
            PRESENCE_TYPES[presenceType] || "Unknown",

            gameName,

            placeId,
            rootPlaceId,
            universeId,

            gameId
        ]
    );
}


// ============================================================
// SESSIONS
// ============================================================

async function startGameSession(player) {

    await pool.query(
        `
        INSERT INTO game_sessions
        (
            user_id,
            username,

            game_name,

            place_id,
            root_place_id,
            universe_id,

            game_id,

            started_at
        )

        VALUES
        (
            $1,$2,
            $3,
            $4,$5,$6,
            $7,
            NOW()
        )
        `,
        [
            player.userId,
            player.username,

            player.gameName,

            player.placeId,
            player.rootPlaceId,
            player.universeId,

            player.gameId
        ]
    );
}


async function closeGameSession(userId) {

    const result = await pool.query(
        `
        SELECT *
        FROM game_sessions

        WHERE
            user_id = $1
            AND ended_at IS NULL

        ORDER BY started_at DESC

        LIMIT 1
        `,
        [userId]
    );

    const session = result.rows[0];

    if (!session)
        return null;

    const started =
        new Date(session.started_at);

    const duration =
        Math.floor(
            (Date.now() - started.getTime()) / 1000
        );

    await pool.query(
        `
        UPDATE game_sessions

        SET
            ended_at = NOW(),
            duration_seconds = $2

        WHERE id = $1
        `,
        [
            session.id,
            duration
        ]
    );

    return {
        ...session,
        duration_seconds: duration
    };
}


// ============================================================
// CURRENT PLAYER
// ============================================================

async function getStoredPlayer(userId) {

    const result = await pool.query(
        `
        SELECT *
        FROM tracked_players
        WHERE user_id = $1
        `,
        [userId]
    );

    return result.rows[0] || null;
}


// ============================================================
// PROCESS PLAYER
// ============================================================

async function processPlayer(
    presence,
    userInfo
) {

    const userId =
        Number(presence.userId);

    const username =
        userInfo?.name ||
        String(userId);

    const displayName =
        userInfo?.displayName ||
        username;

    const presenceType =
        Number(
            presence.userPresenceType || 0
        );

    const placeId =
        presence.placeId
            ? Number(presence.placeId)
            : null;

    const rootPlaceId =
        presence.rootPlaceId
            ? Number(presence.rootPlaceId)
            : null;

    const universeId =
        presence.universeId
            ? Number(presence.universeId)
            : null;

    const gameId =
        presence.gameId
            ? String(presence.gameId)
            : null;

    const lastLocation =
        presence.lastLocation
            ? String(presence.lastLocation)
            : null;

    let gameName = null;

    if (presenceType === 2) {

        const gameInfo =
            await getGameInfo(universeId);

        gameName =
            gameInfo?.name ||
            lastLocation ||
            "Unknown Experience";
    }

    const old =
        await getStoredPlayer(userId);


    // FIRST TIME
    if (!old) {

        await pool.query(
            `
            INSERT INTO tracked_players
            (
                user_id,
                username,
                display_name,

                presence_type,
                presence_name,

                game_name,

                place_id,
                root_place_id,
                universe_id,

                game_id,
                last_location,

                online_since,
                game_started_at,

                last_seen
            )

            VALUES
            (
                $1,$2,$3,

                $4,$5,

                $6,

                $7,$8,$9,

                $10,$11,

                CASE
                    WHEN $4 != 0
                    THEN NOW()
                    ELSE NULL
                END,

                CASE
                    WHEN $4 = 2
                    THEN NOW()
                    ELSE NULL
                END,

                NOW()
            )
            `,
            [
                userId,
                username,
                displayName,

                presenceType,
                PRESENCE_TYPES[presenceType] || "Unknown",

                gameName,

                placeId,
                rootPlaceId,
                universeId,

                gameId,
                lastLocation
            ]
        );

        if (presenceType === 2) {

            await startGameSession({
                userId,
                username,
                gameName,
                placeId,
                rootPlaceId,
                universeId,
                gameId
            });
        }

        return;
    }


    const oldPresence =
        Number(old.presence_type || 0);

    const oldGameName =
        old.game_name || null;

    const oldPlaceId =
        old.place_id
            ? Number(old.place_id)
            : null;

    const oldUniverseId =
        old.universe_id
            ? Number(old.universe_id)
            : null;


    // ONLINE
    if (
        oldPresence === 0 &&
        presenceType !== 0
    ) {

        await saveHistory({
            userId,
            username,
            eventType: "ONLINE",
            presenceType,
            gameName,
            placeId,
            rootPlaceId,
            universeId,
            gameId
        });

        await notify(
            "🟢 Player Online",

            [
                `**Player:** ${username}`,
                `**Status:** ${PRESENCE_TYPES[presenceType]}`,

                gameName
                    ? `**Game:** ${gameName}`
                    : null,

                `**Time:** ${formatTime()}`
            ]
                .filter(Boolean)
                .join("\n"),

            [
                "🟢 <b>PLAYER ONLINE</b>",
                "",
                `👤 ${username}`,
                `📡 ${PRESENCE_TYPES[presenceType]}`,

                gameName
                    ? `🎮 ${gameName}`
                    : "",

                `🕒 ${formatTime()}`
            ]
                .filter(Boolean)
                .join("\n"),

            0x57F287
        );
    }


    // JOINED GAME
    if (
        presenceType === 2 &&
        oldPresence !== 2
    ) {

        await startGameSession({
            userId,
            username,
            gameName,
            placeId,
            rootPlaceId,
            universeId,
            gameId
        });

        await saveHistory({
            userId,
            username,
            eventType: "GAME_JOIN",
            presenceType,
            gameName,
            placeId,
            rootPlaceId,
            universeId,
            gameId
        });

        await notify(
            "🎮 Player Joined Game",

            [
                `**Player:** ${username}`,
                `**Game:** ${gameName}`,
                `**Time:** ${formatTime()}`
            ].join("\n"),

            [
                "🎮 <b>PLAYER JOINED GAME</b>",
                "",
                `👤 ${username}`,
                `🎮 ${gameName}`,
                `🕒 ${formatTime()}`
            ].join("\n"),

            0x5865F2
        );
    }


    // SWITCHED GAME
    const switchedGame =
        presenceType === 2 &&
        oldPresence === 2 &&
        (
            oldUniverseId !== universeId ||
            oldPlaceId !== placeId
        );

    if (switchedGame) {

        const previous =
            await closeGameSession(userId);

        await startGameSession({
            userId,
            username,
            gameName,
            placeId,
            rootPlaceId,
            universeId,
            gameId
        });

        const duration =
            previous
                ? formatDuration(
                    previous.duration_seconds
                )
                : "Unknown";

        await saveHistory({
            userId,
            username,
            eventType: "GAME_SWITCH",
            presenceType,
            gameName,
            placeId,
            rootPlaceId,
            universeId,
            gameId
        });

        await notify(
            "🔄 Player Switched Games",

            [
                `**Player:** ${username}`,
                `**Previous:** ${oldGameName || "Unknown"}`,
                `**Played For:** ${duration}`,
                `**New Game:** ${gameName || "Unknown"}`,
                `**Time:** ${formatTime()}`
            ].join("\n"),

            [
                "🔄 <b>PLAYER SWITCHED GAMES</b>",
                "",
                `👤 ${username}`,
                `⬅️ ${oldGameName || "Unknown"}`,
                `⏱ ${duration}`,
                `➡️ ${gameName || "Unknown"}`,
                `🕒 ${formatTime()}`
            ].join("\n"),

            0xFEE75C
        );
    }


    // OFFLINE
    if (
        oldPresence !== 0 &&
        presenceType === 0
    ) {

        let session = null;

        if (oldPresence === 2) {
            session =
                await closeGameSession(userId);
        }

        const duration =
            session
                ? formatDuration(
                    session.duration_seconds
                )
                : null;

        await saveHistory({
            userId,
            username,
            eventType: "OFFLINE",
            presenceType,
            gameName: oldGameName,
            placeId: oldPlaceId,
            rootPlaceId: old.root_place_id,
            universeId: oldUniverseId,
            gameId: old.game_id
        });

        await notify(
            "🔴 Player Offline",

            [
                `**Player:** ${username}`,

                oldGameName
                    ? `**Last Game:** ${oldGameName}`
                    : null,

                duration
                    ? `**Played For:** ${duration}`
                    : null,

                `**Time:** ${formatTime()}`
            ]
                .filter(Boolean)
                .join("\n"),

            [
                "🔴 <b>PLAYER OFFLINE</b>",
                "",
                `👤 ${username}`,

                oldGameName
                    ? `🎮 ${oldGameName}`
                    : "",

                duration
                    ? `⏱ ${duration}`
                    : "",

                `🕒 ${formatTime()}`
            ]
                .filter(Boolean)
                .join("\n"),

            0xED4245
        );
    }


    // UPDATE STATE
    await pool.query(
        `
        UPDATE tracked_players

        SET
            username = $2,
            display_name = $3,

            presence_type = $4,
            presence_name = $5,

            game_name = $6,

            place_id = $7,
            root_place_id = $8,
            universe_id = $9,

            game_id = $10,
            last_location = $11,

            online_since =
            CASE
                WHEN $4 = 0
                    THEN NULL

                WHEN presence_type = 0
                    THEN NOW()

                ELSE online_since
            END,

            game_started_at =
            CASE
                WHEN $4 != 2
                    THEN NULL

                WHEN
                    presence_type != 2
                    OR universe_id IS DISTINCT FROM $9
                    OR place_id IS DISTINCT FROM $7

                    THEN NOW()

                ELSE game_started_at
            END,

            last_seen = NOW(),
            updated_at = NOW()

        WHERE user_id = $1
        `,
        [
            userId,
            username,
            displayName,

            presenceType,
            PRESENCE_TYPES[presenceType] || "Unknown",

            gameName,

            placeId,
            rootPlaceId,
            universeId,

            gameId,
            lastLocation
        ]
    );
}


// ============================================================
// CHECK PLAYERS
// ============================================================

let checking = false;

async function checkPlayers() {

    if (checking) return;

    checking = true;

    try {

        const trackedUsers =
            await getTrackedUsers();

        if (!trackedUsers.length)
            return;

        const batches =
            chunkArray(
                trackedUsers,
                BATCH_SIZE
            );

        for (const batch of batches) {

            try {

                const [
                    presenceList,
                    users
                ] =
                    await Promise.all([
                        getPresence(batch),
                        getUsers(batch)
                    ]);

                for (
                    const presence
                    of presenceList
                ) {

                    await processPlayer(
                        presence,
                        users.get(
                            Number(
                                presence.userId
                            )
                        )
                    );
                }

            } catch (err) {

                console.error(
                    "Batch error:",
                    err.message
                );
            }

            await sleep(BATCH_DELAY);
        }

    } finally {

        checking = false;
    }
}


// ============================================================
// DASHBOARD
// ============================================================

app.get("/", async (req, res) => {

    res.send(`
<!DOCTYPE html>
<html>

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>Roblox Presence Tracker</title>

<style>

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    font-family:
        Inter,
        Arial,
        sans-serif;

    background: #0f1115;
    color: #ffffff;
}

.container {
    max-width: 1100px;
    margin: auto;
    padding: 30px 20px;
}

h1 {
    margin-bottom: 5px;
}

.subtitle {
    color: #9ca3af;
    margin-bottom: 30px;
}

.card {
    background: #171a21;
    border: 1px solid #252a34;
    border-radius: 14px;
    padding: 20px;
    margin-bottom: 20px;
}

.row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}

input {
    flex: 1;
    min-width: 200px;

    padding: 12px 14px;

    background: #0f1115;
    color: white;

    border: 1px solid #323846;
    border-radius: 8px;

    outline: none;
}

button {
    padding: 12px 18px;

    border: 0;
    border-radius: 8px;

    background: #5865f2;
    color: white;

    cursor: pointer;
    font-weight: 600;
}

button:hover {
    opacity: .9;
}

button.red {
    background: #ed4245;
}

.stats {
    display: grid;

    grid-template-columns:
        repeat(auto-fit, minmax(150px, 1fr));

    gap: 12px;

    margin-bottom: 20px;
}

.stat {
    background: #171a21;
    border: 1px solid #252a34;
    border-radius: 12px;
    padding: 18px;
}

.stat-value {
    font-size: 28px;
    font-weight: 700;
}

.stat-label {
    color: #9ca3af;
    margin-top: 5px;
}

.player {
    display: flex;

    align-items: center;

    justify-content: space-between;

    gap: 15px;

    padding: 15px 0;

    border-bottom:
        1px solid #252a34;
}

.player:last-child {
    border-bottom: 0;
}

.username {
    font-weight: 700;
}

.display {
    color: #9ca3af;
    font-size: 14px;
}

.status {
    margin-top: 5px;
}

.online {
    color: #57f287;
}

.offline {
    color: #9ca3af;
}

.game {
    color: #fee75c;
}

.message {
    margin-top: 12px;
    color: #9ca3af;
}

</style>

</head>

<body>

<div class="container">

<h1>Roblox Presence Tracker</h1>

<div class="subtitle">
Add players by username or user ID.
</div>

<div class="stats">

<div class="stat">
<div
    id="tracked"
    class="stat-value"
>
0
</div>
<div class="stat-label">
Tracked
</div>
</div>

<div class="stat">
<div
    id="online"
    class="stat-value"
>
0
</div>
<div class="stat-label">
Online
</div>
</div>

<div class="stat">
<div
    id="ingame"
    class="stat-value"
>
0
</div>
<div class="stat-label">
In Game
</div>
</div>

</div>


<div class="card">

<h3>Add Player</h3>

<div class="row">

<input
    id="playerInput"
    placeholder="Username or User ID"
>

<input
    id="adminKey"
    placeholder="Admin Key"
    type="password"
>

<button onclick="addPlayer()">
Add Player
</button>

</div>

<div
    id="message"
    class="message"
></div>

</div>


<div class="card">

<h3>Tracked Players</h3>

<div id="players">
Loading...
</div>

</div>

</div>


<script>

function getKey() {
    return document
        .getElementById("adminKey")
        .value
        .trim();
}


async function addPlayer() {

    const value =
        document
            .getElementById("playerInput")
            .value
            .trim();

    const key = getKey();

    const message =
        document
            .getElementById("message");

    if (!value) {
        message.textContent =
            "Enter a username or user ID.";
        return;
    }

    if (!key) {
        message.textContent =
            "Enter your admin key.";
        return;
    }

    message.textContent =
        "Adding player...";

    try {

        const response =
            await fetch(
                "/api/add-player",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",

                        "x-admin-key":
                            key
                    },

                    body:
                        JSON.stringify({
                            value
                        })
                }
            );

        const data =
            await response.json();

        if (!data.success) {
            throw new Error(
                data.error ||
                "Failed"
            );
        }

        message.textContent =
            "Added " +
            data.player.username;

        document
            .getElementById("playerInput")
            .value = "";

        loadDashboard();

    } catch (err) {

        message.textContent =
            err.message;
    }
}


async function removePlayer(userId) {

    const key = getKey();

    if (!key) {
        alert(
            "Enter your admin key first."
        );
        return;
    }

    if (
        !confirm(
            "Remove this player?"
        )
    )
        return;

    const response =
        await fetch(
            "/api/remove-player/" +
            userId,
            {
                method: "DELETE",

                headers: {
                    "x-admin-key": key
                }
            }
        );

    const data =
        await response.json();

    if (!data.success) {
        alert(
            data.error ||
            "Failed"
        );
        return;
    }

    loadDashboard();
}


async function loadDashboard() {

    const key = getKey();

    if (!key)
        return;

    try {

        const response =
            await fetch(
                "/api/dashboard",
                {
                    headers: {
                        "x-admin-key": key
                    }
                }
            );

        const data =
            await response.json();

        if (!data.success)
            return;

        document
            .getElementById("tracked")
            .textContent =
            data.stats.tracked;

        document
            .getElementById("online")
            .textContent =
            data.stats.online;

        document
            .getElementById("ingame")
            .textContent =
            data.stats.in_game;

        const players =
            document
                .getElementById("players");

        if (!data.players.length) {

            players.innerHTML =
                "No players yet.";

            return;
        }

        players.innerHTML =
            data.players
                .map(player => {

                    let status =
                        "Offline";

                    let statusClass =
                        "offline";

                    if (
                        Number(
                            player.presence_type
                        ) === 2
                    ) {

                        status =
                            "🎮 " +
                            (
                                player.game_name ||
                                "In Game"
                            );

                        statusClass =
                            "game";

                    } else if (
                        Number(
                            player.presence_type
                        ) !== 0
                    ) {

                        status =
                            "🟢 " +
                            (
                                player.presence_name ||
                                "Online"
                            );

                        statusClass =
                            "online";
                    }

                    return \`
                    <div class="player">

                        <div>

                            <div class="username">
                                \${player.username}
                            </div>

                            <div class="display">
                                \${player.display_name || ""}
                                • ID \${player.user_id}
                            </div>

                            <div class="status \${statusClass}">
                                \${status}
                            </div>

                        </div>

                        <button
                            class="red"
                            onclick="removePlayer('\${player.user_id}')"
                        >
                            Remove
                        </button>

                    </div>
                    \`;
                })
                .join("");

    } catch (err) {

        console.error(err);
    }
}


document
    .getElementById("adminKey")
    .addEventListener(
        "input",
        () => {

            clearTimeout(
                window.keyTimer
            );

            window.keyTimer =
                setTimeout(
                    loadDashboard,
                    500
                );
        }
    );


setInterval(
    loadDashboard,
    15000
);

</script>

</body>
</html>
    `);
});


// ============================================================
// ADMIN CHECK
// ============================================================

function requireAdmin(
    req,
    res,
    next
) {

    const key =
        req.headers[
            "x-admin-key"
        ];

    if (
        !ADMIN_KEY ||
        key !== ADMIN_KEY
    ) {

        return res
            .status(401)
            .json({
                success: false,
                error:
                    "Invalid admin key."
            });
    }

    next();
}


// ============================================================
// ADD PLAYER BY USERNAME OR ID
// ============================================================

app.post(
    "/api/add-player",

    requireAdmin,

    async (req, res) => {

        try {

            const value =
                String(
                    req.body.value || ""
                ).trim();

            if (!value) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Enter a username or user ID."
                    });
            }

            let user;


            // USER ID
            if (/^\\d+$/.test(value)) {

                const userId =
                    Number(value);

                const users =
                    await getUsers([
                        userId
                    ]);

                user =
                    users.get(
                        userId
                    );

            } else {

                // USERNAME
                user =
                    await getUserByUsername(
                        value
                    );
            }


            if (!user) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        error:
                            "Roblox user not found."
                    });
            }


            const userId =
                Number(user.id);


            await pool.query(
                `
                INSERT INTO tracked_targets
                (
                    user_id,
                    username,
                    display_name,
                    enabled
                )

                VALUES
                (
                    $1,$2,$3,TRUE
                )

                ON CONFLICT(user_id)

                DO UPDATE SET

                    username =
                        EXCLUDED.username,

                    display_name =
                        EXCLUDED.display_name,

                    enabled = TRUE,

                    updated_at =
                        NOW()
                `,
                [
                    userId,
                    user.name,
                    user.displayName
                ]
            );


            res.json({
                success: true,

                player: {
                    userId,
                    username:
                        user.name,

                    displayName:
                        user.displayName
                }
            });

        } catch (err) {

            console.error(err);

            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    }
);


// ============================================================
// REMOVE PLAYER
// ============================================================

app.delete(
    "/api/remove-player/:userId",

    requireAdmin,

    async (req, res) => {

        try {

            const userId =
                Number(
                    req.params.userId
                );


            await pool.query(
                `
                DELETE
                FROM tracked_targets

                WHERE user_id = $1
                `,
                [
                    userId
                ]
            );


            res.json({
                success: true
            });

        } catch (err) {

            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    }
);


// ============================================================
// DASHBOARD DATA
// ============================================================

app.get(
    "/api/dashboard",

    requireAdmin,

    async (req, res) => {

        try {

            const statsResult =
                await pool.query(`
                    SELECT

                    COUNT(*)
                    FILTER (
                        WHERE t.enabled = TRUE
                    )::int
                    AS tracked,

                    COUNT(*)
                    FILTER (
                        WHERE
                        t.enabled = TRUE
                        AND
                        p.presence_type != 0
                    )::int
                    AS online,

                    COUNT(*)
                    FILTER (
                        WHERE
                        t.enabled = TRUE
                        AND
                        p.presence_type = 2
                    )::int
                    AS in_game

                    FROM tracked_targets t

                    LEFT JOIN
                    tracked_players p

                    ON
                    p.user_id =
                    t.user_id
                `);


            const playersResult =
                await pool.query(`
                    SELECT

                        t.user_id,
                        t.username,
                        t.display_name,

                        COALESCE(
                            p.presence_type,
                            0
                        )
                        AS presence_type,

                        p.presence_name,

                        p.game_name,

                        p.place_id,

                        p.universe_id,

                        p.online_since,

                        p.game_started_at,

                        p.last_seen

                    FROM tracked_targets t

                    LEFT JOIN
                    tracked_players p

                    ON
                    p.user_id =
                    t.user_id

                    WHERE
                        t.enabled = TRUE

                    ORDER BY
                        t.username ASC
                `);


            res.json({
                success: true,

                stats:
                    statsResult.rows[0],

                players:
                    playersResult.rows
            });

        } catch (err) {

            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    }
);


// ============================================================
// PLAYER HISTORY
// ============================================================

app.get(
    "/api/history/:userId",

    requireAdmin,

    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM game_sessions

                    WHERE
                        user_id = $1

                    ORDER BY
                        started_at DESC

                    LIMIT 100
                    `,
                    [
                        Number(
                            req.params.userId
                        )
                    ]
                );


            res.json({
                success: true,
                history:
                    result.rows
            });

        } catch (err) {

            res.status(500).json({
                success: false,
                error: err.message
            });
        }
    }
);


// ============================================================
// START
// ============================================================

async function start() {

    await setupDatabase();

    app.listen(
        PORT,
        () => {

            console.log(
                `Server running on ${PORT}`
            );
        }
    );

    await checkPlayers();

    setInterval(
        checkPlayers,
        CHECK_INTERVAL
    );
}


start().catch(err => {

    console.error(
        "Startup failed:",
        err
    );

    process.exit(1);
});
