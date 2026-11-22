// How the bot answers in Discord: to the caller alone, or where others see it.
import { MessageFlags } from "discord.js";

/** @param {import("discord.js").ChatInputCommandInteraction} i @param {string} content */
export const reply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

/** A message others can see. It mentions nobody, because a name in it could be `@everyone`. @param {string} content */
export const noMentions = content => ({ content, allowedMentions: { parse: /** @type {[]} */ ([]) } });
