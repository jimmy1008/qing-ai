"use strict";
const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.join(__dirname, "../../.env") });
dotenv.config({ path: path.join(__dirname, "../../.env.local"), override: true });

const { startDiscordClient } = require("./discord_client");
startDiscordClient();
