// How the bot answers in Discord: to the caller alone, or where others see it.
import { MessageFlags } from "discord.js";

/** @param {import("discord.js").ChatInputCommandInteraction} i @param {string} content */
export const reply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

/** What the bot says where others see it: names in it (any can be `@everyone`) mention nobody. @param {string} content */
export const noMentions = content => ({ content, allowedMentions: { parse: /** @type {[]} */ ([]) } });
