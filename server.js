const express = require("express");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

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
    console.error("DATABASE_URL is missing.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,

    ssl: {
        rejectUnauthorized: false
    },

    max: 10,

    idleTimeoutMillis: 30000,

    connectionTimeoutMillis: 10000
});


// ============================================================
// PRESENCE
// ============================================================

const PRESENCE_TYPES = {
    0: "Offline",
    1: "Online",
    2: "In Game",
    3: "In Studio",
    4: "Invisible"
};


// ============================================================
// SMALL HELPERS
// ============================================================

function sleep(ms) {
    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}


function chunkArray(array, size) {

    const chunks = [];

    for (
        let i = 0;
        i < array.length;
        i += size
    ) {

        chunks.push(
            array.slice(i, i + size)
        );
    }

    return chunks;
}


function formatTime(date = new Date()) {

    return new Intl.DateTimeFormat(
        "en-PH",
        {
            timeZone: "Asia/Manila",

            year: "numeric",

            month: "short",

            day: "numeric",

            hour: "numeric",

            minute: "2-digit",

            second: "2-digit"
        }
    ).format(
        new Date(date)
    );
}


function formatDuration(seconds) {

    seconds =
        Math.max(
            0,
            Math.floor(
                Number(seconds) || 0
            )
        );

    const days =
        Math.floor(
            seconds / 86400
        );

    const hours =
        Math.floor(
            (seconds % 86400) / 3600
        );

    const minutes =
        Math.floor(
            (seconds % 3600) / 60
        );

    const secs =
        seconds % 60;

    const output = [];

    if (days)
        output.push(`${days}d`);

    if (hours)
        output.push(`${hours}h`);

    if (minutes)
        output.push(`${minutes}m`);

    if (
        secs ||
        output.length === 0
    )
        output.push(`${secs}s`);

    return output.join(" ");
}


// ============================================================
// ADMIN KEY
// ============================================================

function requireAdmin(req, res, next) {

    if (!ADMIN_KEY) {

        return res.status(500).json({
            success: false,
            error:
                "ADMIN_KEY is not configured."
        });
    }

    const provided =
        req.headers["x-admin-key"];

    if (provided !== ADMIN_KEY) {

        return res.status(401).json({
            success: false,
            error: "Unauthorized"
        });
    }

    next();
}


// ============================================================
// DATABASE SETUP
// ============================================================

async function setupDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tracked_targets
        (
            user_id BIGINT PRIMARY KEY,

            username TEXT,
            display_name TEXT,

            enabled BOOLEAN
                NOT NULL
                DEFAULT TRUE,

            added_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW(),

            updated_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW()
        );
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS tracked_players
        (
            user_id BIGINT PRIMARY KEY,

            username TEXT,
            display_name TEXT,

            presence_type INTEGER
                NOT NULL
                DEFAULT 0,

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

            created_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW(),

            updated_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW()
        );
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS game_sessions
        (
            id BIGSERIAL PRIMARY KEY,

            user_id BIGINT
                NOT NULL,

            username TEXT,

            game_name TEXT,

            place_id BIGINT,

            root_place_id BIGINT,

            universe_id BIGINT,

            game_id TEXT,

            started_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW(),

            ended_at TIMESTAMPTZ,

            duration_seconds BIGINT,

            created_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW()
        );
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_game_sessions_user
        ON game_sessions(user_id);
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_game_sessions_started
        ON game_sessions(started_at DESC);
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS presence_history
        (
            id BIGSERIAL PRIMARY KEY,

            user_id BIGINT
                NOT NULL,

            username TEXT,

            event_type TEXT
                NOT NULL,

            presence_type INTEGER,

            presence_name TEXT,

            game_name TEXT,

            place_id BIGINT,

            root_place_id BIGINT,

            universe_id BIGINT,

            game_id TEXT,

            created_at TIMESTAMPTZ
                NOT NULL
                DEFAULT NOW()
        );
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_presence_history_user
        ON presence_history(user_id);
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_presence_history_created
        ON presence_history(created_at DESC);
    `);


    console.log(
        "PostgreSQL tables ready."
    );
}


// ============================================================
// ROBLOX USER API
// ============================================================

async function getUsers(userIds) {

    if (!userIds.length)
        return new Map();


    const response = await fetch(
        "https://users.roblox.com/v1/users",
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json"
            },

            body: JSON.stringify({
                userIds,
                excludeBannedUsers: false
            })
        }
    );


    if (!response.ok) {

        const text =
            await response.text();

        throw new Error(
            `Users API ${response.status}: ${text}`
        );
    }


    const json =
        await response.json();


    const output =
        new Map();


    for (
        const user
        of json.data || []
    ) {

        output.set(
            Number(user.id),
            user
        );
    }


    return output;
}


// ============================================================
// ROBLOX PRESENCE
// ============================================================

async function getPresence(userIds) {

    const response = await fetch(
        "https://presence.roblox.com/v1/presence/users",
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json"
            },

            body: JSON.stringify({
                userIds
            })
        }
    );


    if (!response.ok) {

        const text =
            await response.text();

        throw new Error(
            `Presence API ${response.status}: ${text}`
        );
    }


    const json =
        await response.json();


    return (
        json.userPresences || []
    );
}


// ============================================================
// ROBLOX GAME INFO
// ============================================================

async function getGameInfo(universeId) {

    universeId =
        Number(universeId);


    if (!universeId)
        return null;


    try {

        const response = await fetch(
            `https://games.roblox.com/v1/games?universeIds=${universeId}`
        );


        if (!response.ok)
            return null;


        const json =
            await response.json();


        return (
            json.data?.[0] || null
        );

    } catch {

        return null;
    }
}


// ============================================================
// TRACKED TARGETS
// ============================================================

async function getTrackedUsers() {

    const result =
        await pool.query(`
            SELECT user_id
            FROM tracked_targets
            WHERE enabled = TRUE
            ORDER BY added_at ASC
        `);


    return result.rows.map(
        row =>
            Number(row.user_id)
    );
}


// ============================================================
// NOTIFICATIONS
// ============================================================

async function sendDiscord(
    title,
    description,
    color = 0x5865F2
) {

    if (!DISCORD_WEBHOOK)
        return;


    try {

        const response =
            await fetch(
                DISCORD_WEBHOOK,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        embeds: [
                            {
                                title,
                                description,
                                color,
                                timestamp:
                                    new Date()
                                        .toISOString()
                            }
                        ]
                    })
                }
            );


        if (!response.ok) {

            console.error(
                "Discord webhook failed:",
                response.status
            );
        }

    } catch (err) {

        console.error(
            "Discord error:",
            err.message
        );
    }
}


async function sendTelegram(message) {

    if (
        !TELEGRAM_BOT_TOKEN ||
        !TELEGRAM_CHAT_ID
    )
        return;


    try {

        const response =
            await fetch(
                `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            chat_id:
                                TELEGRAM_CHAT_ID,

                            text:
                                message,

                            parse_mode:
                                "HTML",

                            disable_web_page_preview:
                                true
                        })
                }
            );


        if (!response.ok) {

            console.error(
                "Telegram notification failed:",
                response.status
            );
        }

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

            PRESENCE_TYPES[
                presenceType
            ] || "Unknown",

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

async function startGameSession({
    userId,
    username,
    gameName,
    placeId,
    rootPlaceId,
    universeId,
    gameId
}) {

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
            userId,
            username,

            gameName,

            placeId,
            rootPlaceId,
            universeId,

            gameId
        ]
    );
}


async function closeGameSession(
    userId
) {

    const result =
        await pool.query(
            `
            SELECT *
            FROM game_sessions

            WHERE
                user_id = $1
                AND ended_at IS NULL

            ORDER BY started_at DESC

            LIMIT 1
            `,
            [
                userId
            ]
        );


    const session =
        result.rows[0];


    if (!session)
        return null;


    const now =
        new Date();


    const started =
        new Date(
            session.started_at
        );


    const duration =
        Math.max(
            0,

            Math.floor(
                (
                    now.getTime() -
                    started.getTime()
                ) / 1000
            )
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
        duration_seconds:
            duration
    };
}


// ============================================================
// PLAYER STATE
// ============================================================

async function getStoredPlayer(
    userId
) {

    const result =
        await pool.query(
            `
            SELECT *
            FROM tracked_players

            WHERE user_id = $1
            `,
            [
                userId
            ]
        );


    return (
        result.rows[0] ||
        null
    );
}


// ============================================================
// PROCESS PRESENCE
// ============================================================

async function processPlayer(
    presence,
    userInfo
) {

    const userId =
        Number(
            presence.userId
        );


    const username =
        userInfo?.name ||
        String(userId);


    const displayName =
        userInfo?.displayName ||
        username;


    const presenceType =
        Number(
            presence.userPresenceType ||
            0
        );


    const placeId =
        presence.placeId
            ? Number(
                presence.placeId
            )
            : null;


    const rootPlaceId =
        presence.rootPlaceId
            ? Number(
                presence.rootPlaceId
            )
            : null;


    const universeId =
        presence.universeId
            ? Number(
                presence.universeId
            )
            : null;


    const gameId =
        presence.gameId
            ? String(
                presence.gameId
            )
            : null;


    const lastLocation =
        presence.lastLocation
            ? String(
                presence.lastLocation
            )
            : null;


    let gameName = null;


    if (presenceType === 2) {

        if (universeId) {

            const info =
                await getGameInfo(
                    universeId
                );


            gameName =
                info?.name ||
                lastLocation ||
                "Unknown Experience";

        } else {

            gameName =
                lastLocation ||
                "Unknown Experience";
        }
    }


    const old =
        await getStoredPlayer(
            userId
        );


    // ========================================================
    // FIRST TIME
    // ========================================================

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
                PRESENCE_TYPES[
                    presenceType
                ] || "Unknown",

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


        console.log(
            `[INIT] ${username} -> ${
                PRESENCE_TYPES[
                    presenceType
                ]
            } ${
                gameName || ""
            }`
        );


        return;
    }


    const oldPresence =
        Number(
            old.presence_type || 0
        );


    const oldGameName =
        old.game_name || null;


    const oldPlaceId =
        old.place_id
            ? Number(
                old.place_id
            )
            : null;


    const oldUniverseId =
        old.universe_id
            ? Number(
                old.universe_id
            )
            : null;


    const oldGameId =
        old.game_id
            ? String(
                old.game_id
            )
            : null;


    // ========================================================
    // OFFLINE -> ONLINE
    // ========================================================

    if (
        oldPresence === 0 &&
        presenceType !== 0
    ) {

        await saveHistory({
            userId,
            username,

            eventType:
                "ONLINE",

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
                `**Display:** ${displayName}`,
                `**Status:** ${
                    PRESENCE_TYPES[
                        presenceType
                    ]
                }`,

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
                `📡 ${
                    PRESENCE_TYPES[
                        presenceType
                    ]
                }`,

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


    // ========================================================
    // ENTERED GAME
    // ========================================================

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

            eventType:
                "GAME_JOIN",

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
                `**Game:** ${
                    gameName ||
                    "Unknown"
                }`,

                universeId
                    ? `**Universe ID:** ${universeId}`
                    : null,

                placeId
                    ? `**Place ID:** ${placeId}`
                    : null,

                `**Time:** ${formatTime()}`
            ]
                .filter(Boolean)
                .join("\n"),

            [
                "🎮 <b>PLAYER JOINED GAME</b>",
                "",
                `👤 ${username}`,
                `🎮 ${
                    gameName ||
                    "Unknown"
                }`,

                universeId
                    ? `🌐 Universe: ${universeId}`
                    : "",

                placeId
                    ? `📍 Place: ${placeId}`
                    : "",

                `🕒 ${formatTime()}`
            ]
                .filter(Boolean)
                .join("\n"),

            0x5865F2
        );
    }


    // ========================================================
    // SWITCHED GAME
    // ========================================================

    const switchedGame =
        presenceType === 2 &&
        oldPresence === 2 &&

        (
            (
                universeId &&
                oldUniverseId &&
                universeId !==
                oldUniverseId
            )

            ||

            (
                placeId &&
                oldPlaceId &&
                placeId !==
                oldPlaceId
            )
        );


    if (switchedGame) {

        const previousSession =
            await closeGameSession(
                userId
            );


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

            eventType:
                "GAME_SWITCH",

            presenceType,

            gameName,

            placeId,
            rootPlaceId,
            universeId,

            gameId
        });


        const duration =
            previousSession

                ? formatDuration(
                    previousSession
                        .duration_seconds
                )

                : "Unknown";


        await notify(
            "🔄 Player Switched Games",

            [
                `**Player:** ${username}`,
                "",
                `**Previous Game:** ${
                    oldGameName ||
                    "Unknown"
                }`,
                `**Played For:** ${duration}`,
                "",
                `**New Game:** ${
                    gameName ||
                    "Unknown"
                }`,
                `**Time:** ${formatTime()}`
            ].join("\n"),

            [
                "🔄 <b>PLAYER SWITCHED GAMES</b>",
                "",
                `👤 ${username}`,
                "",
                `⬅️ ${
                    oldGameName ||
                    "Unknown"
                }`,
                `⏱ ${duration}`,
                "",
                `➡️ ${
                    gameName ||
                    "Unknown"
                }`,
                "",
                `🕒 ${formatTime()}`
            ].join("\n"),

            0xFEE75C
        );
    }


    // ========================================================
    // LEFT GAME BUT STILL ONLINE
    // ========================================================

    if (
        oldPresence === 2 &&
        presenceType !== 2 &&
        presenceType !== 0
    ) {

        const session =
            await closeGameSession(
                userId
            );


        const duration =
            session

                ? formatDuration(
                    session
                        .duration_seconds
                )

                : "Unknown";


        await saveHistory({
            userId,
            username,

            eventType:
                "GAME_LEAVE",

            presenceType,

            gameName:
                oldGameName,

            placeId:
                oldPlaceId,

            rootPlaceId:
                old.root_place_id,

            universeId:
                oldUniverseId,

            gameId:
                oldGameId
        });


        await notify(
            "🚪 Player Left Game",

            [
                `**Player:** ${username}`,
                `**Last Game:** ${
                    oldGameName ||
                    "Unknown"
                }`,
                `**Played For:** ${duration}`,
                `**Current Status:** ${
                    PRESENCE_TYPES[
                        presenceType
                    ]
                }`,
                `**Time:** ${formatTime()}`
            ].join("\n"),

            [
                "🚪 <b>PLAYER LEFT GAME</b>",
                "",
                `👤 ${username}`,
                `🎮 ${
                    oldGameName ||
                    "Unknown"
                }`,
                `⏱ ${duration}`,
                `📡 ${
                    PRESENCE_TYPES[
                        presenceType
                    ]
                }`,
                `🕒 ${formatTime()}`
            ].join("\n"),

            0xFEE75C
        );
    }


    // ========================================================
    // WENT OFFLINE
    // ========================================================

    if (
        oldPresence !== 0 &&
        presenceType === 0
    ) {

        let session = null;


        if (oldPresence === 2) {

            session =
                await closeGameSession(
                    userId
                );
        }


        const duration =
            session

                ? formatDuration(
                    session
                        .duration_seconds
                )

                : null;


        await saveHistory({
            userId,
            username,

            eventType:
                "OFFLINE",

            presenceType,

            gameName:
                oldGameName,

            placeId:
                oldPlaceId,

            rootPlaceId:
                old.root_place_id,

            universeId:
                oldUniverseId,

            gameId:
                oldGameId
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

                `**Offline:** ${formatTime()}`
            ]
                .filter(Boolean)
                .join("\n"),

            [
                "🔴 <b>PLAYER OFFLINE</b>",
                "",
                `👤 ${username}`,

                oldGameName
                    ? `🎮 Last Game: ${oldGameName}`
                    : "",

                duration
                    ? `⏱ Played: ${duration}`
                    : "",

                `🕒 ${formatTime()}`
            ]
                .filter(Boolean)
                .join("\n"),

            0xED4245
        );
    }


    // ========================================================
    // UPDATE CURRENT STATE
    // ========================================================

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

                    OR

                    universe_id
                    IS DISTINCT FROM
                    $9

                    OR

                    place_id
                    IS DISTINCT FROM
                    $7

                    THEN NOW()

                ELSE
                    game_started_at
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
            PRESENCE_TYPES[
                presenceType
            ] || "Unknown",

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
// MAIN TRACKER
// ============================================================

let checking = false;


async function checkPlayers() {

    if (checking)
        return;


    checking = true;


    try {

        const trackedUsers =
            await getTrackedUsers();


        if (!trackedUsers.length) {

            console.log(
                "No tracked players."
            );

            return;
        }


        console.log(
            `Checking ${trackedUsers.length} tracked players...`
        );


        const batches =
            chunkArray(
                trackedUsers,
                BATCH_SIZE
            );


        for (
            const batch
            of batches
        ) {

            try {

                const [
                    presenceList,
                    users
                ] =
                    await Promise.all([
                        getPresence(
                            batch
                        ),

                        getUsers(
                            batch
                        )
                    ]);


                for (
                    const presence
                    of presenceList
                ) {

                    try {

                        await processPlayer(
                            presence,

                            users.get(
                                Number(
                                    presence.userId
                                )
                            )
                        );

                    } catch (err) {

                        console.error(
                            `Player ${
                                presence.userId
                            } failed:`,
                            err.message
                        );
                    }
                }

            } catch (err) {

                console.error(
                    "Batch failed:",
                    err.message
                );
            }


            await sleep(
                BATCH_DELAY
            );
        }

    } catch (err) {

        console.error(
            "Tracker failed:",
            err
        );

    } finally {

        checking = false;
    }
}


// ============================================================
// HOME
// ============================================================

app.get(
    "/",
    async (req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT
                    COUNT(*)::int
                    AS count

                    FROM tracked_targets

                    WHERE enabled = TRUE
                `);


            res.json({
                success: true,

                service:
                    "Roblox Presence Tracker",

                trackedPlayers:
                    result.rows[0].count,

                interval:
                    CHECK_INTERVAL
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
// ADD TRACKED USER
// ============================================================

app.post(
    "/track",

    requireAdmin,

    async (req, res) => {

        try {

            const userId =
                Number(
                    req.body.userId
                );


            if (
                !Number.isSafeInteger(
                    userId
                ) ||
                userId <= 0
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Invalid Roblox userId."
                    });
            }


            const users =
                await getUsers([
                    userId
                ]);


            const user =
                users.get(
                    userId
                );


            if (!user) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        error:
                            "Roblox user not found."
                    });
            }


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

                    updated_at = NOW()
                `,
                [
                    userId,
                    user.name,
                    user.displayName
                ]
            );


            res.json({
                success: true,

                message:
                    "Player added to tracker.",

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
// ADD MANY USERS
// ============================================================

app.post(
    "/track/bulk",

    requireAdmin,

    async (req, res) => {

        try {

            const supplied =
                Array.isArray(
                    req.body.userIds
                )
                    ? req.body.userIds
                    : [];


            const userIds =
                [
                    ...new Set(
                        supplied

                            .map(Number)

                            .filter(
                                x =>
                                    Number
                                        .isSafeInteger(
                                            x
                                        )
                                    &&
                                    x > 0
                            )
                    )
                ];


            if (!userIds.length) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "Send userIds as an array."
                    });
            }


            const added = [];
            const failed = [];


            const batches =
                chunkArray(
                    userIds,
                    BATCH_SIZE
                );


            for (
                const batch
                of batches
            ) {

                try {

                    const users =
                        await getUsers(
                            batch
                        );


                    for (
                        const userId
                        of batch
                    ) {

                        const user =
                            users.get(
                                userId
                            );


                        if (!user) {

                            failed.push(
                                userId
                            );

                            continue;
                        }


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


                        added.push({
                            userId,
                            username:
                                user.name,
                            displayName:
                                user.displayName
                        });
                    }

                } catch {

                    failed.push(
                        ...batch
                    );
                }


                await sleep(
                    BATCH_DELAY
                );
            }


            res.json({
                success: true,

                addedCount:
                    added.length,

                failedCount:
                    failed.length,

                added,
                failed
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
// REMOVE PLAYER
// ============================================================

app.delete(
    "/track/:userId",

    requireAdmin,

    async (req, res) => {

        try {

            const userId =
                Number(
                    req.params.userId
                );


            const result =
                await pool.query(
                    `
                    DELETE
                    FROM tracked_targets

                    WHERE user_id = $1

                    RETURNING *
                    `,
                    [
                        userId
                    ]
                );


            if (
                !result.rows.length
            ) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        error:
                            "Player is not tracked."
                    });
            }


            res.json({
                success: true,

                message:
                    "Player removed."
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
// DISABLE TRACKING
// ============================================================

app.patch(
    "/track/:userId/disable",

    requireAdmin,

    async (req, res) => {

        try {

            await pool.query(
                `
                UPDATE tracked_targets

                SET
                    enabled = FALSE,
                    updated_at = NOW()

                WHERE user_id = $1
                `,
                [
                    Number(
                        req.params.userId
                    )
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
// ENABLE TRACKING
// ============================================================

app.patch(
    "/track/:userId/enable",

    requireAdmin,

    async (req, res) => {

        try {

            await pool.query(
                `
                UPDATE tracked_targets

                SET
                    enabled = TRUE,
                    updated_at = NOW()

                WHERE user_id = $1
                `,
                [
                    Number(
                        req.params.userId
                    )
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
// TRACKED LIST
// ============================================================

app.get(
    "/tracked",

    requireAdmin,

    async (req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT
                        user_id,
                        username,
                        display_name,
                        enabled,
                        added_at,
                        updated_at

                    FROM tracked_targets

                    ORDER BY
                        added_at DESC
                `);


            res.json({
                success: true,

                count:
                    result.rows.length,

                players:
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
// CURRENT PLAYER STATES
// ============================================================

app.get(
    "/players",

    requireAdmin,

    async (req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT
                        p.*

                    FROM tracked_players p

                    INNER JOIN
                        tracked_targets t

                    ON
                        t.user_id =
                        p.user_id

                    WHERE
                        t.enabled = TRUE

                    ORDER BY
                        p.username ASC
                `);


            res.json({
                success: true,

                count:
                    result.rows.length,

                players:
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
// ONE PLAYER
// ============================================================

app.get(
    "/player/:userId",

    requireAdmin,

    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM tracked_players

                    WHERE user_id = $1
                    `,
                    [
                        Number(
                            req.params.userId
                        )
                    ]
                );


            res.json({
                success: true,

                player:
                    result.rows[0] ||
                    null
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
// GAME HISTORY
// ============================================================

app.get(
    "/history/:userId",

    requireAdmin,

    async (req, res) => {

        try {

            const limit =
                Math.min(
                    Number(
                        req.query.limit
                    ) || 100,

                    1000
                );


            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM game_sessions

                    WHERE user_id = $1

                    ORDER BY
                        started_at DESC

                    LIMIT $2
                    `,
                    [
                        Number(
                            req.params.userId
                        ),

                        limit
                    ]
                );


            res.json({
                success: true,

                count:
                    result.rows.length,

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
// EVENT HISTORY
// ============================================================

app.get(
    "/events/:userId",

    requireAdmin,

    async (req, res) => {

        try {

            const limit =
                Math.min(
                    Number(
                        req.query.limit
                    ) || 100,

                    1000
                );


            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM presence_history

                    WHERE user_id = $1

                    ORDER BY
                        created_at DESC

                    LIMIT $2
                    `,
                    [
                        Number(
                            req.params.userId
                        ),

                        limit
                    ]
                );


            res.json({
                success: true,

                count:
                    result.rows.length,

                events:
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
// STATS
// ============================================================

app.get(
    "/stats",

    requireAdmin,

    async (req, res) => {

        try {

            const result =
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


            res.json({
                success: true,
                ...result.rows[0]
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
// MANUAL CHECK
// ============================================================

app.post(
    "/check-now",

    requireAdmin,

    async (req, res) => {

        checkPlayers()
            .catch(console.error);


        res.json({
            success: true,
            message:
                "Presence check started."
        });
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
                `Server running on port ${PORT}`
            );

            console.log(
                `Presence interval: ${CHECK_INTERVAL}ms`
            );

            console.log(
                `Batch size: ${BATCH_SIZE}`
            );
        }
    );


    await checkPlayers();


    setInterval(
        () => {

            checkPlayers()
                .catch(console.error);

        },

        CHECK_INTERVAL
    );
}


start()
    .catch(err => {

        console.error(
            "Startup error:",
            err
        );

        process.exit(1);
    });
