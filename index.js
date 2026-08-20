import {
  ActivityType,
  ActionRowBuilder,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";

import { EdgeTTS } from "node-edge-tts";
import { Readable } from "node:stream";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";


/* =========================================================
   CONFIGURATION
========================================================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const MAX_MESSAGE_LENGTH = 500;
const EMPTY_CHANNEL_LEAVE_DELAY_MS = 30_000;
const SPEAKER_REPEAT_WINDOW_MS = 8_000;
const MAX_JOB_RETRIES = 3;
const RETRY_DELAY_MS = 750;
const MAX_VOLUME = 2.0;
const JOIN_SOUND_FILE = path.join(process.cwd(), "bozos-tts-join.mp3");

// Natural speech is the default. Per-server presets can override rate/pitch,
// while Discord-side volume is handled separately so loudness is consistent.
const TTS_VOICE_SETTINGS = {
  rate: "+0%",
  pitch: "+0Hz",
  volume: "+0%",
  outputFormat: "audio-24khz-96kbitrate-mono-mp3",
  saveSubtitles: false,
  timeout: 30_000,
};

const VOICE_PRESETS = {
  natural: { label: "Natural", rate: 0, pitch: 0 },
  clear: { label: "Clear", rate: -2, pitch: 0 },
  calm: { label: "Calm", rate: -8, pitch: -2 },
  energetic: { label: "Energetic", rate: 8, pitch: 2 },
  narrator: { label: "Narrator", rate: -10, pitch: -4 },
  bright: { label: "Bright", rate: 4, pitch: 3 },
};

const VOICE_ACCENTS = {
  english: {
    default: "en-US-JennyNeural",
    us: "en-US-JennyNeural",
    uk: "en-GB-LibbyNeural",
    au: "en-AU-NatashaNeural",
    in: "en-IN-NeerjaNeural",
    ca: "en-CA-ClaraNeural",
  },
  spanish: {
    default: "es-ES-ElviraNeural",
    es: "es-ES-ElviraNeural",
    mx: "es-MX-DaliaNeural",
    us: "es-US-PalomaNeural",
  },
  portuguese: {
    default: "pt-BR-FranciscaNeural",
    br: "pt-BR-FranciscaNeural",
    pt: "pt-PT-RaquelNeural",
  },
  french: {
    default: "fr-FR-DeniseNeural",
    fr: "fr-FR-DeniseNeural",
    ca: "fr-CA-SylvieNeural",
  },
  german: {
    default: "de-DE-KatjaNeural",
    de: "de-DE-KatjaNeural",
    at: "de-AT-IngridNeural",
    ch: "de-CH-LeniNeural",
  },
  chinese: {
    default: "zh-CN-XiaoxiaoNeural",
    cn: "zh-CN-XiaoxiaoNeural",
    tw: "zh-TW-HsiaoChenNeural",
  },
  arabic: {
    default: "ar-SA-ZariyahNeural",
    sa: "ar-SA-ZariyahNeural",
    ae: "ar-AE-FatimaNeural",
    eg: "ar-EG-SalmaNeural",
  },
  hindi: { default: "hi-IN-SwaraNeural", in: "hi-IN-SwaraNeural" },
  bengali: { default: "bn-IN-TanishaNeural", in: "bn-IN-TanishaNeural" },
  tamil: { default: "ta-IN-PallaviNeural", in: "ta-IN-PallaviNeural" },
  telugu: { default: "te-IN-ShrutiNeural", in: "te-IN-ShrutiNeural" },
  marathi: { default: "mr-IN-AarohiNeural", in: "mr-IN-AarohiNeural" },
  gujarati: { default: "gu-IN-DhwaniNeural", in: "gu-IN-DhwaniNeural" },
  kannada: { default: "kn-IN-SapnaNeural", in: "kn-IN-SapnaNeural" },
  malayalam: { default: "ml-IN-SobhanaNeural", in: "ml-IN-SobhanaNeural" },
  punjabi: { default: "pa-IN-VaaniNeural", in: "pa-IN-VaaniNeural" },
};

const EMOJI_SPOKEN_NAMES = new Map([
  ["😂", "laughing"], ["🤣", "rolling laughing"], ["😭", "crying"],
  ["😢", "sad"], ["😅", "nervous laugh"], ["😆", "laughing"],
  ["😊", "smiling"], ["🙂", "slightly smiling"], ["😉", "wink"],
  ["😍", "heart eyes"], ["🥰", "loving"], ["😘", "kiss"],
  ["😎", "cool"], ["🤔", "thinking"], ["😐", "neutral"],
  ["🙄", "eye roll"], ["😳", "surprised"], ["😱", "screaming"],
  ["🤯", "mind blown"], ["😡", "angry"], ["🤬", "very angry"],
  ["🥳", "celebrating"], ["🎉", "party"], ["🔥", "fire"],
  ["💀", "skull"], ["☠️", "skull and crossbones"], ["❤️", "heart"],
  ["💔", "broken heart"], ["👍", "thumbs up"], ["👎", "thumbs down"],
  ["👏", "clapping"], ["🙏", "praying"], ["💯", "hundred percent"],
  ["✨", "sparkles"], ["⭐", "star"], ["🚀", "rocket"], ["💩", "poop"],
]);


const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://bozosforever.vercel.app";
const SUPPORT_SERVER_URL = process.env.SUPPORT_SERVER_URL || "https://discord.gg/Z4dkNHqfdg";

const SUPPORT_USER_ID = "1458470088759054525";

function getBotInviteUrl() {
  const clientId = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID || client.user?.id;

  if (!clientId) {
    return SUPPORT_SERVER_URL;
  }

  return (
    "https://discord.com/oauth2/authorize?" +
    new URLSearchParams({
      client_id: clientId,
      permissions: "36769024",
      scope: "bot applications.commands",
    }).toString()
  );
}

/* Comprehensive global language dictionary mapping standard codes
  to Microsoft Edge TTS neural voices and localized introductory prefixes.
*/
const LANGUAGE_CONFIGS = {
  english: { label: "English", voice: "en-GB-LibbyNeural", lang: "en-GB", prefix: (name) => `${name} said...` },
  hindi: { label: "Hindi", voice: "hi-IN-SwaraNeural", lang: "hi-IN", prefix: (name) => `${name} ne kaha...` },
  spanish: { label: "Spanish", voice: "es-ES-ElviraNeural", lang: "es-ES", prefix: (name) => `${name} dijo...` },
  french: { label: "French", voice: "fr-FR-DeniseNeural", lang: "fr-FR", prefix: (name) => `${name} a dit...` },
  german: { label: "German", voice: "de-DE-KatjaNeural", lang: "de-DE", prefix: (name) => `${name} sagte...` },
  chinese: { label: "Chinese (Mandarin)", voice: "zh-CN-XiaoxiaoNeural", lang: "zh-CN", prefix: (name) => `${name} 说...` },
  japanese: { label: "Japanese", voice: "ja-JP-NanamiNeural", lang: "ja-JP", prefix: (name) => `${name} が言いました...` },
  arabic: { label: "Arabic", voice: "ar-SA-ZariyahNeural", lang: "ar-SA", prefix: (name) => `قال ${name}...` },
  russian: { label: "Russian", voice: "ru-RU-SvetlanaNeural", lang: "ru-RU", prefix: (name) => `${name} сказал...` },
  portuguese: { label: "Portuguese", voice: "pt-BR-FranciscaNeural", lang: "pt-BR", prefix: (name) => `${name} disse...` },
  italian: { label: "Italian", voice: "it-IT-ElsaNeural", lang: "it-IT", prefix: (name) => `${name} ha detto...` },
  korean: { label: "Korean", voice: "ko-KR-SunHiNeural", lang: "ko-KR", prefix: (name) => `${name}님이 말씀하셨습니다...` },
  bengali: { label: "Bengali", voice: "bn-IN-TanishaNeural", lang: "bn-IN", prefix: (name) => `${name} বলেছেন...` },
  turkish: { label: "Turkish", voice: "tr-TR-EmelNeural", lang: "tr-TR", prefix: (name) => `${name} dedi ki...` },
  vietnamese: { label: "Vietnamese", voice: "vi-VN-HoaiMyNeural", lang: "vi-VN", prefix: (name) => `${name} đã nói...` },
  polish: { label: "Polish", voice: "pl-PL-ZofiaNeural", lang: "pl-PL", prefix: (name) => `${name} powiedział...` },
  ukrainian: { label: "Ukrainian", voice: "uk-UA-PolinaNeural", lang: "uk-UA", prefix: (name) => `${name} сказав...` },
  dutch: { label: "Dutch", voice: "nl-NL-FennaNeural", lang: "nl-NL", prefix: (name) => `${name} zei...` },
  greek: { label: "Greek", voice: "el-GR-AthinaNeural", lang: "el-GR", prefix: (name) => `Ο/Η ${name} είπε...` },
  swedish: { label: "Swedish", voice: "sv-SE-SofieNeural", lang: "sv-SE", prefix: (name) => `${name} sa...` },
  indonesian: { label: "Indonesian", voice: "id-ID-GadisNeural", lang: "id-ID", prefix: (name) => `${name} berkata...` },
  hebrew: { label: "Hebrew", voice: "he-IL-HilaNeural", lang: "he-IL", prefix: (name) => `${name} אמר...` },
  romanian: { label: "Romanian", voice: "ro-RO-AlinaNeural", lang: "ro-RO", prefix: (name) => `${name} a spus...` },
  filipino: { label: "Filipino", voice: "fil-PH-BlessicaNeural", lang: "fil-PH", prefix: (name) => `Sabi ni ${name}...` },
  malay: { label: "Malay", voice: "ms-MY-YasminNeural", lang: "ms-MY", prefix: (name) => `${name} berkata...` },
  thai: { label: "Thai", voice: "th-TH-PremwadeeNeural", lang: "th-TH", prefix: (name) => `${name} พูดว่า...` },
  tamil: { label: "Tamil", voice: "ta-IN-PallaviNeural", lang: "ta-IN", prefix: (name) => `${name} கூறினார்...` },
  telugu: { label: "Telugu", voice: "te-IN-ShrutiNeural", lang: "te-IN", prefix: (name) => `${name} చెప్పారు...` },
  marathi: { label: "Marathi", voice: "mr-IN-AarohiNeural", lang: "mr-IN", prefix: (name) => `${name} म्हणाले...` },
  gujarati: { label: "Gujarati", voice: "gu-IN-DhwaniNeural", lang: "gu-IN", prefix: (name) => `${name} એ કહ્યું...` },
  kannada: { label: "Kannada", voice: "kn-IN-SapnaNeural", lang: "kn-IN", prefix: (name) => `${name} ಹೇಳಿದರು...` },
  malayalam: { label: "Malayalam", voice: "ml-IN-SobhanaNeural", lang: "ml-IN", prefix: (name) => `${name} പറഞ്ഞു...` },
  urdu: { label: "Urdu", voice: "ur-PK-UzmaNeural", lang: "ur-PK", prefix: (name) => `نے کہا ${name}...` },
  persian: { label: "Persian", voice: "fa-IR-DilaraNeural", lang: "fa-IR", prefix: (name) => `${name} گفت...` },
  czech: { label: "Czech", voice: "cs-CZ-VlastaNeural", lang: "cs-CZ", prefix: (name) => `${name} řekl...` },
  hungarian: { label: "Hungarian", voice: "hu-HU-NoemiNeural", lang: "hu-HU", prefix: (name) => `${name} mondta...` },
  finnish: { label: "Finnish", voice: "fi-FI-NooraNeural", lang: "fi-FI", prefix: (name) => `${name} sanoi...` },
  danish: { label: "Danish", voice: "da-DK-ChristelNeural", lang: "da-DK", prefix: (name) => `${name} sagde...` },
  norwegian: { label: "Norwegian", voice: "nb-NO-PernilleNeural", lang: "nb-NO", prefix: (name) => `${name} sa...` },
  croatian: { label: "Croatian", voice: "hr-HR-GabrijelaNeural", lang: "hr-HR", prefix: (name) => `${name} je rekao...` },
  slovak: { label: "Slovak", voice: "sk-SK-ViktoriaNeural", lang: "sk-SK", prefix: (name) => `${name} povedal...` },
  bulgarian: { label: "Bulgarian", voice: "bg-BG-KalinaNeural", lang: "bg-BG", prefix: (name) => `${name} каза...` },
  serbian: { label: "Serbian", voice: "sr-RS-SophieNeural", lang: "sr-RS", prefix: (name) => `${name} је рекао...` },
  slovenian: { label: "Slovenian", voice: "sl-SI-PetraNeural", lang: "sl-SI", prefix: (name) => `${name} je rekel...` },
  catalan: { label: "Catalan", voice: "ca-ES-JoanaNeural", lang: "ca-ES", prefix: (name) => `${name} ha dit...` },
  irish: { label: "Irish", voice: "ga-IE-OrlaNeural", lang: "ga-IE", prefix: (name) => `${name} a dúirt...` },
  welsh: { label: "Welsh", voice: "cy-GB-NiaNeural", lang: "cy-GB", prefix: (name) => `${name} a ddywedodd...` },
  estonian: { label: "Estonian", voice: "et-EE-AnuNeural", lang: "et-EE", prefix: (name) => `${name} ütles...` },
  latvian: { label: "Latvian", voice: "lv-LV-EveritaNeural", lang: "lv-LV", prefix: (name) => `${name} teica...` },
  lithuanian: { label: "Lithuanian", voice: "lt-LT-OnaNeural", lang: "lt-LT", prefix: (name) => `${name} sakė...` },
  swahili: { label: "Swahili", voice: "sw-KE-ZuriNeural", lang: "sw-KE", prefix: (name) => `${name} alisema...` },
  afrikaans: { label: "Afrikaans", voice: "af-ZA-AdriNeural", lang: "af-ZA", prefix: (name) => `${name} het gesê...` },
  amharic: { label: "Amharic", voice: "am-ET-MekdesNeural", lang: "am-ET", prefix: (name) => `${name} alē...` },
  yoruba: { label: "Yoruba", voice: "yo-NG-AbebiNeural", lang: "yo-NG", prefix: (name) => `${name} sọ pé...` },
  zulu: { label: "Zulu", voice: "zu-ZA-ThandoNeural", lang: "zu-ZA", prefix: (name) => `U-${name} uthe...` },
  punjabi: { label: "Punjabi", voice: "pa-IN-VaaniNeural", lang: "pa-IN", prefix: (name) => `${name}:` }
};

// In-memory per-guild settings. Settings reset when the bot process restarts.
// This intentionally avoids filesystem/database persistence so the repo stays self-contained.
const guildSettingsCache = new Map();

const DEFAULT_GUILD_SETTINGS = {
  serverLanguage: "english",
  serverAccent: "us",
  volume: 1,
  voicePreset: "natural",
  // Kept for backward compatibility with older settings files.
  accent: "default",
  speakerMode: "smart",
  speakerRepeatWindowMs: SPEAKER_REPEAT_WINDOW_MS,
  // Join + leave announcements are intentionally one setting.
  announcements: {
    enabled: false,
  },
  userLanguages: {},
  userAccents: {},
};

function cloneDefaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_GUILD_SETTINGS));
}

function getGuildSettings(guildId) {
  if (!guildSettingsCache.has(guildId)) {
    guildSettingsCache.set(guildId, cloneDefaultSettings());
  }
  return guildSettingsCache.get(guildId);
}

function getGuildLanguageSelection(guildId, userId = null) {
  const settings = getGuildSettings(guildId);

  if (userId && settings.userLanguages[userId]) {
    return {
      language: settings.userLanguages[userId],
      accent: settings.userAccents[userId] || getDefaultAccent(settings.userLanguages[userId]),
    };
  }

  return {
    language: settings.serverLanguage || "english",
    accent: settings.serverAccent || getDefaultAccent(settings.serverLanguage || "english"),
  };
}

function getGuildLanguage(guildId, userId = null) {
  return getGuildLanguageSelection(guildId, userId).language;
}

function getGuildLanguageConfig(guildId, userId = null) {
  const language = getGuildLanguage(guildId, userId);
  return LANGUAGE_CONFIGS[language] || LANGUAGE_CONFIGS.english;
}

function getDefaultAccent(languageKey) {
  const accents = VOICE_ACCENTS[languageKey];
  if (accents?.default) return accents.default;
  const config = LANGUAGE_CONFIGS[languageKey] || LANGUAGE_CONFIGS.english;
  return localeRegion(config.lang || "en-US");
}

function localeRegion(locale) {
  return String(locale || "").split("-")[1]?.toLowerCase() || "default";
}

function getAccentEntries(languageKey) {
  const accents = VOICE_ACCENTS[languageKey];
  if (accents) {
    const preferredRegionOrder = ["us", "in", "uk", "au", "ca", "ie", "nz", "za", "sg", "ng", "ph", "my", "mx", "es", "br", "pt", "fr", "de", "at", "ch", "cn", "tw", "hk", "sa", "ae", "eg"];
    return Object.entries(accents)
      .filter(([key]) => key !== "default")
      .sort(([a], [b]) => {
        const ai = preferredRegionOrder.indexOf(a);
        const bi = preferredRegionOrder.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      })
      .map(([key, voice]) => ({ key, voice }));
  }

  const config = LANGUAGE_CONFIGS[languageKey];
  return config ? [{ key: localeRegion(config.lang), voice: config.voice }] : [];
}

function getVoiceForLanguage(languageKey, accent = "default") {
  const config = LANGUAGE_CONFIGS[languageKey] || LANGUAGE_CONFIGS.english;
  const accents = VOICE_ACCENTS[languageKey];
  if (accents) return accents[accent] || accents.default || config.voice;
  return config.voice;
}

function getEffectiveAccent(guildId, userId = null) {
  return getGuildLanguageSelection(guildId, userId).accent;
}

function getLanguageVariantLabel(languageKey, accent) {
  const config = LANGUAGE_CONFIGS[languageKey] || LANGUAGE_CONFIGS.english;
  const entries = getAccentEntries(languageKey);
  const entry = entries.find(item => item.key === accent);
  const voice = entry?.voice || getVoiceForLanguage(languageKey, accent);
  const region = localeRegion(voice);
  return `${config.label} (${region.toUpperCase()})`;
}

function getLanguageVariants() {
  const variants = [];
  for (const [languageKey, config] of Object.entries(LANGUAGE_CONFIGS)) {
    const entries = getAccentEntries(languageKey);
    for (const entry of entries) {
      variants.push({
        value: `${languageKey}::${entry.key}`,
        languageKey,
        accent: entry.key,
        label: getLanguageVariantLabel(languageKey, entry.key),
        config,
      });
    }
  }
  return variants;
}

function getEffectiveVoiceSettings(guildId, userId = null) {
  const settings = getGuildSettings(guildId);
  const preset = VOICE_PRESETS[settings.voicePreset] || VOICE_PRESETS.natural;
  return {
    rate: `${preset.rate >= 0 ? "+" : ""}${preset.rate}%`,
    pitch: `${preset.pitch >= 0 ? "+" : ""}${preset.pitch}Hz`,
    volume: "+0%",
    outputFormat: TTS_VOICE_SETTINGS.outputFormat,
    saveSubtitles: false,
    timeout: TTS_VOICE_SETTINGS.timeout,
    accent: getEffectiveAccent(guildId, userId),
    volumeMultiplier: settings.volume,
  };
}

function getLanguageListString() {
  return Object.values(LANGUAGE_CONFIGS)
    .map(conf => `• ${conf.label}`)
    .join("\n");
}

const HELP_CATEGORIES = {
  home: {
    emoji: "🏠",
    label: "Home",
    description: "The main help menu.",
    title: "🏠 Home",
    body:
      "Welcome to Bozos TTS, your high-speed, multi-language neural text-to-speech companion!\n\n" +
      "**Choose a category in the select menu to show commands.**",
  },
  CoreCommands: {
    emoji: "⚡",
    label: "Core Commands",
    description: "Manage voice connections, languages, and bot operations.",
    title: "⚡ Core Commands",
    body:
      "`/join` — Join your current voice channel.\n" +
      "`/leave` — Disconnect from the voice channel.\n" +
      "`/language` — Choose a server or personal language + regional accent.\n" +
      "`/volume` — Set playback volume from 0–200%.\n" +
      "`/voice` — Choose a natural speech preset.\n" +
      "" +
      "`/skip` — Skip the current TTS message.\n\n" +
      "**Choose a category in the select menu to show commands.**",
  },

  SupportedLanguages: {
    emoji: "🌐",
    label: "Supported Languages",
    description: "Explore all supported neural text-to-speech languages.",
    title: "🌐 Supported Languages",
    get body() {
      const languages = Object.values(LANGUAGE_CONFIGS).map(c => c.label).join(", ");
      const variantCount = getLanguageVariants().length;
      return `Bozos TTS supports **${Object.keys(LANGUAGE_CONFIGS).length} languages** across **${variantCount} regional voices**:\n\n${languages}\n\nUse \`/language\` to choose both language and accent!`;
    },
  },
  support: {
    emoji: "🛠️",
    label: "Support",
    description: "Help, support server, and bot links.",
    title: "🛠️ Support",
    body:
      "`/support`: Get bot support information.\n\n" +
      "Use the buttons below to open the dashboard, invite the bot, or join the support server.\n\n" +
      "**Choose a category in the select menu to show commands.**",
  },
  };

function buildHelpSelectMenu(selectedCategory = "home") {
  return new StringSelectMenuBuilder()
    .setCustomId("bozos_help_category")
    .setPlaceholder("Select a category")
    .addOptions(
      Object.entries(HELP_CATEGORIES).map(([value, category]) => ({
        label: category.label,
        description: category.description,
        value,
        emoji: category.emoji,
        default: value === selectedCategory,
      }))
    );
}

function buildHelpButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Dashboard")
      .setEmoji("🌐")
      .setStyle(ButtonStyle.Link)
      .setURL(DASHBOARD_URL),
    new ButtonBuilder()
      .setLabel("Invite")
      .setEmoji("📥")
      .setStyle(ButtonStyle.Link)
      .setURL(getBotInviteUrl()),
    new ButtonBuilder()
      .setLabel("Support")
      .setEmoji("💬")
      .setStyle(ButtonStyle.Link)
      .setURL(SUPPORT_SERVER_URL)
  );
}

function buildHelpV2Payload(categoryKey = "home") {
  const category = HELP_CATEGORIES[categoryKey] || HELP_CATEGORIES.home;
  const selectedCategory = HELP_CATEGORIES[categoryKey] ? categoryKey : "home";

  const container = new ContainerBuilder()
    .setAccentColor(0x8b2cff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${category.title}\n${category.body}`)
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(buildHelpButtons())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(buildHelpSelectMenu(selectedCategory))
    );

  return {
    flags: MessageFlags.IsComponentsV2 | 64,
    components: [container],
  };
}
  

function buildSpeechText(speakerName, cleanedMessage, guildId, userId = null, includeSpeakerName = true) {
  if (!includeSpeakerName) return cleanedMessage;

  // A colon gives the TTS engine a natural pause without forcing the repetitive
  // "John said..." construction on every message.
  return `${speakerName}: ${cleanedMessage}`;
}

function shouldAnnounceSpeaker(state, guild, member, now = performance.now()) {
  const settings = getGuildSettings(guild.id);
  if (settings.speakerMode === "never") return false;
  if (settings.speakerMode === "always") return true;

  const humanCount = getHumanMembersInVoiceChannel(guild, state.voiceChannelId)?.size ?? 99;
  if (humanCount <= 2) return false;

  if (!state.lastQueuedSpeakerId) return true;
  if (state.lastQueuedSpeakerId !== member.id) return true;
  return now - state.lastQueuedSpeakerAt > settings.speakerRepeatWindowMs;
}

const COLORS = {
  SUCCESS: 0x57f287,
  INFO: 0x5865f2,
  WARNING: 0xfee75c,
  ERROR: 0xed4245,
};


if (!DISCORD_TOKEN) {
  throw new Error(
    "DISCORD_TOKEN is missing from environment variables."
  );
}


/* =========================================================
   DISCORD CLIENT
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

/* =========================================================
   SLASH COMMANDS
========================================================= */

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription(
      "Join your voice channel and read its chat messages aloud"
    ),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription(
      "Disconnect the bot and stop reading voice-channel chat"
    ),

  new SlashCommandBuilder()
    .setName("language")
    .setDescription("Choose Bozos TTS language for the server or just yourself")
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription("Who should this language apply to?")
        .setRequired(false)
        .addChoices(
          { name: "Server default", value: "server" },
          { name: "Only me", value: "personal" },
        )
    ),

  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set Bozos playback volume for this server")
    .addIntegerOption((option) =>
      option
        .setName("percent")
        .setDescription("0–200%")
        .setMinValue(0)
        .setMaxValue(200)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Choose a natural voice preset")
    .addStringOption((option) =>
      option
        .setName("preset")
        .setDescription("Speech style")
        .setRequired(true)
        .addChoices(...Object.entries(VOICE_PRESETS).map(([value, preset]) => ({ name: preset.label, value })))
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the message Bozos is currently speaking"),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Toggle voice-channel join and leave announcements")
    .addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription("Enable or disable join and leave announcements")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription(
      "Show commands and information about the Bozos TTS Bot"
    ),

  new SlashCommandBuilder()
    .setName("support")
    .setDescription("Get bot support information."),
].map((command) => command.toJSON());


/* =========================================================
   COMPONENTS V2 HELPERS
========================================================= */

function createV2Container({
  title,
  description,
  color = COLORS.INFO,
}) {
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      (textDisplay) =>
        textDisplay.setContent(
          `## ${title}\n${description}`
        )
    );
}


async function replyWithV2(
  interaction,
  {
    title,
    description,
    color = COLORS.INFO,
    ephemeral = false,
  }
) {
  const container = createV2Container({
    title,
    description,
    color,
  });

  if (
    interaction.replied ||
    interaction.deferred
  ) {
    return interaction.editReply({
      components: [container],
    });
  }

  const flags = ephemeral
    ? [
        MessageFlags.IsComponentsV2,
        MessageFlags.Ephemeral,
      ]
    : MessageFlags.IsComponentsV2;

  return interaction.reply({
    components: [container],
    flags,
  });
}


/* =========================================================
   GUILD STATES
========================================================= */

const guildStates = new Map();


function createGuildState(guildId) {
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  const state = {
    voiceChannelId: null,
    lastVoiceChannelId: null,
    connection: null,
    player,
    queue: [],
    currentJob: null,
    processing: false,
    skipRequested: false,
    emptyChannelTimer: null,
    reconnectTimer: null,
    manualDisconnect: false,
    lastQueuedSpeakerId: null,
    lastQueuedSpeakerAt: 0,
  };

  player.on("error", (error) => {
    console.error(
      `[Voice] Player error in guild ${guildId}:`,
      error
    );
  });

  guildStates.set(guildId, state);

  return state;
}


function getGuildState(guildId) {
  return (
    guildStates.get(guildId) ||
    createGuildState(guildId)
  );
}


function clearEmptyChannelTimer(state) {
  if (!state?.emptyChannelTimer) {
    return;
  }

  clearTimeout(state.emptyChannelTimer);
  state.emptyChannelTimer = null;
}


/* =========================================================
   EDGE TTS
========================================================= */

async function normalizeLoudness(inputPath) {
  if (!ffmpegPath) return inputPath;

  const outputPath = path.join(
    os.tmpdir(),
    `bozos-normalized-${crypto.randomUUID()}.mp3`
  );

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", inputPath,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-ar", "24000",
      "-ac", "1",
      "-codec:a", "libmp3lame",
      "-b:a", "96k",
      outputPath,
    ]);

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg loudness normalization failed (${code}): ${stderr.trim()}`));
    });
  });

  await fs.promises.unlink(inputPath).catch(() => {});
  return outputPath;
}

async function generateTtsFile(text, guildId, userId = null) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("TTS text cannot be empty.");

  const languageKey = getGuildLanguage(guildId, userId);
  const languageConfig = getGuildLanguageConfig(guildId, userId);
  const voiceSettings = getEffectiveVoiceSettings(guildId, userId);
  const voice = getVoiceForLanguage(languageKey, voiceSettings.accent);
  const { accent, volumeMultiplier, ...ttsSettings } = voiceSettings;

  const voiceLocale = voice.split("-").slice(0, 2).join("-");
  const edgeTts = new EdgeTTS({
    voice,
    lang: voiceLocale || languageConfig.lang,
    ...ttsSettings,
  });

  const outputPath = path.join(
    os.tmpdir(),
    `bozos-tts-${crypto.randomUUID()}.mp3`
  );

  const startedAt = performance.now();
  await edgeTts.ttsPromise(cleanText, outputPath);

  try {
    const stats = await fs.promises.stat(outputPath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error("Edge TTS generated an empty audio file.");
    }

    const normalizedPath = await normalizeLoudness(outputPath);
    const elapsed = Math.round(performance.now() - startedAt);

    console.log(
      `[TTS] Generated ${languageConfig.label} / ${voice} audio in ${elapsed} ms.`
    );

    return normalizedPath;
  } catch (error) {
    await fs.promises.unlink(outputPath).catch(() => {});
    throw error;
  }
}

/* =========================================================
   VOICE CONNECTION
========================================================= */

async function connectToVoiceChannel(voiceChannel, state) {
  clearEmptyChannelTimer(state);
  state.manualDisconnect = false;
  state.lastVoiceChannelId = voiceChannel.id;

  let connection = getVoiceConnection(voiceChannel.guild.id);

  if (connection && connection.joinConfig.channelId !== voiceChannel.id) {
    connection.destroy();
    connection = null;
  }

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    connection.on("error", (error) => {
      console.error(`[Voice] Connection error in guild ${voiceChannel.guild.id}:`, error);
      scheduleVoiceReconnect(voiceChannel.guild.id);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      scheduleVoiceReconnect(voiceChannel.guild.id);
    });
  }

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  connection.subscribe(state.player);

  state.connection = connection;
  state.voiceChannelId = voiceChannel.id;
  state.lastVoiceChannelId = voiceChannel.id;
  return connection;
}

function scheduleVoiceReconnect(guildId, delay = 1_000) {
  const state = guildStates.get(guildId);
  if (!state || state.manualDisconnect || state.reconnectTimer) return;

  state.connection = null;
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;

    if (state.manualDisconnect || !state.lastVoiceChannelId) return;

    const guild = client.guilds.cache.get(guildId);
    const voiceChannel = guild?.channels.cache.get(state.lastVoiceChannelId);
    if (!voiceChannel?.isVoiceBased()) return;

    const humans = getHumanMembersInVoiceChannel(guild, voiceChannel.id);
    if (!humans || humans.size === 0) {
      destroyGuildState(guildId);
      return;
    }

    try {
      await connectToVoiceChannel(voiceChannel, state);
      console.log(`[Voice] Reconnected to ${voiceChannel.id} in guild ${guildId}. Queue preserved (${state.queue.length}).`);
      if (state.queue.length > 0) void processGuildQueue(guildId, state);
    } catch (error) {
      console.error(`[Voice] Reconnect failed in guild ${guildId}:`, error);
      scheduleVoiceReconnect(guildId, Math.min(delay * 2, 30_000));
    }
  }, delay);
}


function destroyGuildState(guildId) {
  const state =
    guildStates.get(guildId);

  if (state) {
    clearEmptyChannelTimer(state);

    state.queue.length = 0;
    state.currentJob = null;
    state.processing = false;
    state.skipRequested = false;
    state.manualDisconnect = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    try {
      state.player.stop(true);
    } catch {
      // Player may already be stopped.
    }

    try {
      state.connection?.destroy();
    } catch {
      // Connection may already be destroyed.
    }
  }

  const connection =
    getVoiceConnection(guildId);

  try {
    connection?.destroy();
  } catch {
    // Connection may already be destroyed.
  }

  guildStates.delete(guildId);
}


/* =========================================================
   EMPTY VOICE CHANNEL HANDLING
========================================================= */

function getHumanMembersInVoiceChannel(
  guild,
  voiceChannelId
) {
  const voiceChannel =
    guild.channels.cache.get(
      voiceChannelId
    );

  if (!voiceChannel?.isVoiceBased()) {
    return null;
  }

  return voiceChannel.members.filter(
    (member) => !member.user.bot
  );
}


function updateEmptyChannelTimer(guildId) {
  const state =
    guildStates.get(guildId);

  if (!state?.voiceChannelId) {
    return;
  }

  const guild =
    client.guilds.cache.get(guildId);

  if (!guild) {
    return;
  }

  const humanMembers =
    getHumanMembersInVoiceChannel(
      guild,
      state.voiceChannelId
    );

  if (!humanMembers) {
    destroyGuildState(guildId);
    return;
  }

  if (humanMembers.size > 0) {
    clearEmptyChannelTimer(state);
    return;
  }

  if (state.emptyChannelTimer) {
    return;
  }

  console.log(
    `[Voice] VC is empty in guild ${guildId}. Leaving in 30 seconds.`
  );

  state.emptyChannelTimer =
    setTimeout(() => {
      const latestState =
        guildStates.get(guildId);

      if (!latestState?.voiceChannelId) {
        return;
      }

      const latestGuild =
        client.guilds.cache.get(
          guildId
        );

      if (!latestGuild) {
        destroyGuildState(guildId);
        return;
      }

      const latestHumans =
        getHumanMembersInVoiceChannel(
          latestGuild,
          latestState.voiceChannelId
        );

      if (latestHumans?.size > 0) {
        clearEmptyChannelTimer(
          latestState
        );

        return;
      }

      destroyGuildState(guildId);

      console.log(
        `[Voice] Left guild ${guildId} after the VC remained empty for 30 seconds.`
      );
    }, EMPTY_CHANNEL_LEAVE_DELAY_MS);
}


/* =========================================================
   PLAYBACK
========================================================= */

function waitForPlaybackToFinish(player) {
  return new Promise((resolve, reject) => {
    let startedPlaying = false;

    const timeout = setTimeout(() => {
      cleanup();

      reject(
        new Error("Audio playback timed out.")
      );
    }, 180_000);

    function cleanup() {
      clearTimeout(timeout);

      player.removeListener(
        AudioPlayerStatus.Playing,
        onPlaying
      );

      player.removeListener(
        AudioPlayerStatus.Idle,
        onIdle
      );

      player.removeListener(
        "error",
        onError
      );
    }

    function onPlaying() {
      startedPlaying = true;
    }

    function onIdle() {
      if (!startedPlaying) {
        return;
      }

      cleanup();
      resolve();
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    player.on(
      AudioPlayerStatus.Playing,
      onPlaying
    );

    player.on(
      AudioPlayerStatus.Idle,
      onIdle
    );

    player.on(
      "error",
      onError
    );
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function playJoinSound(guildId, state) {
  if (!fs.existsSync(JOIN_SOUND_FILE)) {
    console.log("[Join Sound] bozos-tts-join.mp3 not found.");
    return;
  }

  if (state.processing) {
    console.log("[Join Sound] Skipped because TTS queue is already processing.");
    return;
  }

  state.processing = true;

  try {
    await wait(1500);

    const resource = createAudioResource(JOIN_SOUND_FILE);

    state.player.play(resource);

    await waitForPlaybackToFinish(state.player);
    console.log("[Join Sound] Bozos TTS join sound played.");
  } catch (error) {
    console.error("[Join Sound] Failed to play Bozos TTS join sound:", error);
  } finally {
    state.processing = false;

    if (state.queue.length > 0) {
      void processGuildQueue(guildId, state);
    }
  }
}


/* =========================================================
   MESSAGE QUEUE
========================================================= */

/* =========================================================
   MESSAGE QUEUE (Upgraded for RAM Streaming)
========================================================= */

async function processGuildQueue(guildId, state) {
  if (state.processing) return;
  state.processing = true;

  try {
    while (state.queue.length > 0) {
      const job = state.queue.shift();
      state.currentJob = job;
      let audioPath = null;

      try {
        if (!state.voiceChannelId || state.voiceChannelId !== job.voiceChannelId) continue;
        if (!job.isAnnouncement && (!job.member || job.member.voice.channelId !== state.voiceChannelId)) continue;

        const voiceChannel = job.guild.channels.cache.get(state.voiceChannelId);
        if (!voiceChannel?.isVoiceBased()) throw new Error("The tracked voice channel no longer exists.");

        await connectToVoiceChannel(voiceChannel, state);

        audioPath = await generateTtsFile(job.speechText, guildId, job.isAnnouncement ? null : job.userId);

        if (state.skipRequested) {
          await fs.promises.unlink(audioPath).catch(() => {});
          audioPath = null;
          state.skipRequested = false;
          continue;
        }

        const audioBuffer = await fs.promises.readFile(audioPath);
        await fs.promises.unlink(audioPath).catch(() => {});
        audioPath = null;

        const settings = getGuildSettings(guildId);
        const audioStream = Readable.from(audioBuffer);
        const resource = createAudioResource(audioStream, {
          inlineVolume: true,
          silencePaddingFrames: 2,
        });
        resource.volume?.setVolume(settings.volume);

        console.log(
          `[Latency] Message-to-playback: ${Math.round(performance.now() - job.messageReceivedAt)} ms`
        );

        state.skipRequested = false;
        state.player.play(resource);
        await waitForPlaybackToFinish(state.player);

        if (state.skipRequested) state.skipRequested = false;
      } catch (error) {
        const attempts = (job.attempts || 0) + 1;
        job.attempts = attempts;

        console.error(`[TTS] Queue item failed in guild ${guildId} (attempt ${attempts}/${MAX_JOB_RETRIES}):`, error);

        // Keep the job for transient provider/voice failures. Messages from users
        // who already left the VC are still discarded on the next pass.
        if (attempts < MAX_JOB_RETRIES && state.voiceChannelId === job.voiceChannelId) {
          state.queue.unshift(job);
          await wait(RETRY_DELAY_MS * attempts);
          if (!state.connection) scheduleVoiceReconnect(guildId);
        }
      } finally {
        if (audioPath) await fs.promises.unlink(audioPath).catch(() => {});
        state.currentJob = null;
      }
    }
  } finally {
    state.processing = false;
    updateEmptyChannelTimer(guildId);
  }
}

/* =========================================================
   MESSAGE CLEANING
========================================================= */

function isLikelyBotCommand(content) {
  const text = String(content || "").trim();
  if (!text) return false;

  // Slash commands are handled by Discord as interactions and should never
  // become TTS input. The rest is deliberately conservative so normal chat
  // such as "I love !play" is still spoken.
  if (text.startsWith("/")) return true;

  const musicCommands = /^(?:m!|music!|dj!|song!)(?:play|stop|pause|resume|skip|queue|q|np|nowplaying|lyrics|seek|loop|shuffle|volume|vol|join|leave|disconnect|clear|remove|replay|previous|prev)(?:\s|$)/i;
  if (musicCommands.test(text)) return true;

  const commonPrefixedCommands = /^(?:!|\?|\.)(?:play|stop|pause|resume|skip|queue|q|np|nowplaying|lyrics|seek|loop|shuffle|volume|vol|join|leave|disconnect|clear|remove|replay|previous|prev)(?:\s|$)/i;
  return commonPrefixedCommands.test(text);
}

function humanizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const serviceNames = [
      ["youtube.com", "YouTube"], ["youtu.be", "YouTube"],
      ["spotify.com", "Spotify"], ["github.com", "GitHub"],
      ["gitlab.com", "GitLab"], ["reddit.com", "Reddit"],
      ["twitch.tv", "Twitch"], ["discord.com", "Discord"],
      ["discord.gg", "Discord"], ["x.com", "X"],
      ["twitter.com", "Twitter"], ["instagram.com", "Instagram"],
      ["tiktok.com", "TikTok"], ["steamcommunity.com", "Steam"],
    ];
    const service = serviceNames.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1];
    return service ? `a ${service} link` : `a link to ${host}`;
  } catch {
    return "a link";
  }
}

function normalizeMarkdown(text) {
  let output = text;
  output = output.replace(/```[\s\S]*?```/g, " code block ");
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, "$1");
  output = output.replace(/`([^`]+)`/g, "$1");
  output = output.replace(/~~([^~]+)~~/g, "$1");
  output = output.replace(/\*\*([^*]+)\*\*/g, "$1");
  output = output.replace(/__([^_]+)__/g, "$1");
  output = output.replace(/(^|\n)\s*>+\s?/g, "$1");
  output = output.replace(/(^|\n)\s*#{1,6}\s+/g, "$1");
  output = output.replace(/(^|\n)\s*[-*+]\s+/g, "$1");
  return output;
}

function normalizeNumbersDatesAndTimes(text, language = "en-US") {
  let output = text;

  // Dates written in ISO form are awkward for speech; turn them into a
  // locale-appropriate long date without changing the actual date.
  output = output.replace(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, (_, y, m, d) => {
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (Number.isNaN(date.getTime())) return `${y}-${m}-${d}`;
    return new Intl.DateTimeFormat(language, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  });

  // Make clocks more speech-friendly: 8:30 PM -> 8 30 PM.
  output = output.replace(/\b(\d{1,2}):(\d{2})(?:\s*([ap]m))?\b/gi, (_, h, m, meridiem = "") =>
    `${h} ${m}${meridiem ? ` ${meridiem.toUpperCase()}` : ""}`
  );

  output = output.replace(/([₹$€£])\s?(\d[\d,]*(?:\.\d+)?)/g, (_, symbol, value) => {
    const names = { "₹": "rupees", "$": "dollars", "€": "euros", "£": "pounds" };
    return `${value} ${names[symbol]}`;
  });

  output = output.replace(/\b(\d+(?:\.\d+)?)%/g, "$1 percent");
  output = output.replace(/\b(\d[\d,]*)\s?km\/h\b/gi, "$1 kilometers per hour");
  output = output.replace(/\b(\d[\d,]*)\s?km\b/gi, "$1 kilometers");

  return output;
}

function normalizePunctuation(text) {
  let output = text;
  output = output.replace(/\.\.\./g, "…");
  output = output.replace(/!{2,}/g, "!");
  output = output.replace(/\?{2,}/g, "?");
  output = output.replace(/,{2,}/g, ",");
  output = output.replace(/;{2,}/g, ";");
  output = output.replace(/\s+([,.!?;:])/g, "$1");
  output = output.replace(/([,.!?;:])(?=\S)/g, "$1 ");
  output = output.replace(/\s*[-–—]{2,}\s*/g, ", ");
  output = output.replace(/\s+/g, " ").trim();
  return output;
}

function normalizeEmoji(text) {
  let output = text;

  output = output.replace(/<a?:(\w+):\d+>/g, (_, name) => `${name.replace(/[_-]+/g, " ")} emoji`);

  for (const [emoji, spoken] of [...EMOJI_SPOKEN_NAMES.entries()].sort((a, b) => b[0].length - a[0].length)) {
    output = output.split(emoji).join(` ${spoken} `);
  }

  // Unknown emoji are usually less useful than the literal word "emoji".
  // Remove them rather than making the TTS engine pronounce visual glyphs.
  output = output.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, " ");
  return output;
}

function describeAttachments(message) {
  if (!message?.attachments?.size) return "";

  const counts = { image: 0, video: 0, audio: 0, file: 0 };
  for (const attachment of message.attachments.values()) {
    const type = attachment.contentType || "";
    if (type.startsWith("image/")) counts.image++;
    else if (type.startsWith("video/")) counts.video++;
    else if (type.startsWith("audio/")) counts.audio++;
    else counts.file++;
  }

  const parts = [];
  for (const [type, count] of Object.entries(counts)) {
    if (!count) continue;
    const label = count === 1 ? type : `${type}s`;
    parts.push(`${count} ${label}`);
  }
  return parts.length ? ` Also sent ${parts.join(" and ")}.` : "";
}

function replaceDiscordMentions(text, message) {
  let output = text;
  output = output.replace(/@(everyone|here)\b/g, "$1");

  output = output.replace(/<@!?(\d+)>/g, (_, id) => {
    const member = message.guild?.members?.cache?.get(id);
    return member?.displayName || member?.user?.username || message.client?.users?.cache?.get(id)?.username || "someone";
  });

  output = output.replace(/<@&(\d+)>/g, (_, id) => {
    const role = message.guild?.roles?.cache?.get(id);
    return role?.name || "a role";
  });

  output = output.replace(/<#(\d+)>/g, (_, id) => {
    const channel = message.guild?.channels?.cache?.get(id);
    return channel?.name ? `the ${channel.name} channel` : "a channel";
  });

  return output;
}

function prepareMessageForSpeech(message, userId = null) {
  let text = String(message?.content || "").trim();
  if (!text && !message?.attachments?.size) return "";

  if (isLikelyBotCommand(text)) return "";

  text = normalizeMarkdown(text);
  text = replaceDiscordMentions(text, message);
  text = text.replace(/https?:\/\/\S+/gi, (url) => humanizeUrl(url));
  text = normalizeEmoji(text);

  const languageKey = getGuildLanguage(message.guildId, userId);
  const languageConfig = getGuildLanguageConfig(message.guildId, userId);
  text = normalizeNumbersDatesAndTimes(text, languageConfig.lang || "en-US");
  text = normalizePunctuation(text);

  const attachmentText = describeAttachments(message);
  text = `${text}${attachmentText}`.trim();
  text = text.replace(/\s+/g, " ").trim();

  if (text.length > MAX_MESSAGE_LENGTH) {
    text = `${text.slice(0, MAX_MESSAGE_LENGTH - 3).trimEnd()}...`;
  }

  return text;
}



/* =========================================================
   READY EVENT
========================================================= */

/* =========================================================
   READY EVENT
========================================================= */

client.once(
  Events.ClientReady,
  async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);

    readyClient.user.setPresence({
      activities: [
        {
          name: "/help • Bozos TTS",
          type: ActivityType.Custom,
        },
      ],
      status: "online",
    });

    console.log(`[Guilds] Bot is currently in ${readyClient.guilds.cache.size} servers:`);
    readyClient.guilds.cache.forEach((guild) => {
      console.log(`- Server Name: ${guild.name} | ID: ${guild.id} | Members: ${guild.memberCount}`);
    });

    try {
      // 1. Clear leftover guild-level commands to avoid duplicates
      for (const guild of readyClient.guilds.cache.values()) {
        await guild.commands.set([]).catch((error) => {
          console.error(
            `[Commands] Failed to clear old commands in ${guild.name}:`,
            error
          );
        });
      }

      // 2. Register global slash commands
      await readyClient.application.commands.set(commands);
      console.log("Registered global commands.");

      // 3. Register /maintenance ONLY in your private admin server
      const ADMIN_GUILD_ID = "1523281886011592795"; // Replace with your Server ID
      const adminGuild = readyClient.guilds.cache.get(ADMIN_GUILD_ID);

      if (adminGuild) {
        await adminGuild.commands.set([
          new SlashCommandBuilder()
            .setName("maintenance")
            .setDescription("Play maintenance audio across all connected VCs (Owner Only)"),
        ]);
        console.log(`[Admin] Registered /maintenance in server: ${adminGuild.name}`);
      }
    } catch (error) {
      console.error("Failed to register commands:", error);
    }
  }
);

/* =========================================================
   INTERACTION HANDLER (Commands, Select Menus, & Buttons)
========================================================= */

function generateLanguageMenuComponents(page = 0, scope = "server") {
  const entries = getLanguageVariants();
  const pageSize = 25; // Discord StringSelectMenu maximum.
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const pageEntries = entries.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`lang_select_${scope}_${currentPage}`)
    .setPlaceholder(`Select language + accent (Page ${currentPage + 1}/${totalPages})`)
    .addOptions(
      pageEntries.map((entry) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(entry.label)
          .setValue(entry.value)
      )
    );

  const rowMenu = new ActionRowBuilder().addComponents(selectMenu);
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lang_page_${scope}_${currentPage - 1}`)
      .setLabel("⬅️ Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`lang_page_${scope}_${currentPage + 1}`)
      .setLabel("Next ➡️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1),
  );

  return { components: [rowMenu, rowButtons], currentPage, totalPages };
}


client.on(
  Events.InteractionCreate,
  async (interaction) => {
    // Handle Pagination Buttons for /language menu
    if (interaction.isButton() && interaction.customId.startsWith("lang_page_")) {
      const [, , scope, page] = interaction.customId.split("_");
      const pageNum = parseInt(page, 10);
      const { components } = generateLanguageMenuComponents(pageNum, scope || "server");

      await interaction.update({
        components: [
          new ContainerBuilder()
            .setAccentColor(COLORS.INFO)
            .addTextDisplayComponents((td) => td.setContent(
              `## 🌐 Choose Bozos TTS Language\n${scope === "personal" ? "This changes your personal language and accent only." : "This changes the server default language and accent."}`
            )),
          ...components,
        ],
      }).catch(() => {});
      return;
    }

    // HELP CATEGORY SELECT MENU
  if (interaction.isStringSelectMenu() && interaction.customId === "bozos_help_category") {
    const selectedCategory = interaction.values?.[0] || "home";

    return interaction.update(buildHelpV2Payload(selectedCategory));
  }

    // Handle Dropdown Selection for Language
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("lang_select_")) {
      const [, , scope] = interaction.customId.split("_");
      const [selectedLanguage, selectedAccent] = String(interaction.values[0] || "").split("::");
      const languageConfig = LANGUAGE_CONFIGS[selectedLanguage];

      if (!languageConfig || !selectedAccent) {
        return interaction.reply({ content: "Invalid language/accent choice.", flags: MessageFlags.Ephemeral });
      }

      const validAccent = getAccentEntries(selectedLanguage).some((entry) => entry.key === selectedAccent);
      if (!validAccent) {
        return interaction.reply({ content: "That regional voice is not available.", flags: MessageFlags.Ephemeral });
      }

      const settings = getGuildSettings(interaction.guildId);
      if (scope === "personal") {
        settings.userLanguages[interaction.user.id] = selectedLanguage;
        settings.userAccents[interaction.user.id] = selectedAccent;
      } else {
        settings.serverLanguage = selectedLanguage;
        settings.serverAccent = selectedAccent;
      }

      const selectedLabel = getLanguageVariantLabel(selectedLanguage, selectedAccent);
      await interaction.update({
        components: [
          new ContainerBuilder()
            .setAccentColor(COLORS.SUCCESS)
            .addTextDisplayComponents((td) => td.setContent(
              `## ✅ Language Updated\n${scope === "personal" ? "Your personal" : "Server default"} language and accent are now **${selectedLabel}**.`
            )),
        ],
      }).catch(() => {});
      return;
    }

    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    if (!interaction.inGuild()) {
      return replyWithV2(
        interaction,
        {
          title: "Server Only Command",
          description:
            "This command can only be used inside a Discord server.",
          color: COLORS.ERROR,
          ephemeral: true,
        }
      );
    }


    /* -----------------------------------------------------
       /JOIN
    ----------------------------------------------------- */

    if (
      interaction.commandName ===
      "join"
    ) {
      const voiceChannel =
        interaction.member
          ?.voice
          ?.channel;

      if (!voiceChannel) {
        return replyWithV2(
          interaction,
          {
            title:
              "Voice Channel Required",
            description:
              "Join a voice channel first, then run `/join` again.",
            color: COLORS.ERROR,
            ephemeral: true,
          }
        );
      }

      const permissions =
        voiceChannel.permissionsFor(
          interaction.guild.members.me
        );

      if (
        !permissions?.has(
          PermissionFlagsBits.ViewChannel
        ) ||
        !permissions?.has(
          PermissionFlagsBits.Connect
        ) ||
        !permissions?.has(
          PermissionFlagsBits.Speak
        )
      ) {
        return replyWithV2(
          interaction,
          {
            title:
              "Missing Permissions",

            description:
              `I need these permissions in <#${voiceChannel.id}>:\n\n` +
              "• **View Channel**\n" +
              "• **Connect**\n" +
              "• **Speak**",

            color: COLORS.ERROR,
            ephemeral: true,
          }
        );
      }

      const existingConnection =
        getVoiceConnection(
          interaction.guildId
        );

      const existingState =
        guildStates.get(
          interaction.guildId
        );

      const connectedChannelId =
        existingConnection
          ?.joinConfig
          ?.channelId ||
        existingState
          ?.voiceChannelId ||
        null;

      if (
        existingConnection &&
        connectedChannelId ===
          voiceChannel.id
      ) {
        if (existingState) {
          clearEmptyChannelTimer(
            existingState
          );
        }

        return replyWithV2(
          interaction,
          {
            title:
              "Already Connected",

            description:
              `I am already connected to <#${voiceChannel.id}>.\n\n` +
              "Messages posted in this voice channel's chat will continue to be spoken aloud.",

            color: COLORS.WARNING,
          }
        );
      }

      await replyWithV2(
        interaction,
        {
          title: "Connecting",
          description:
            `Joining <#${voiceChannel.id}> and preparing voice-chat TTS...`,
          color: COLORS.INFO,
        }
      );

      try {
        const previousState =
          guildStates.get(
            interaction.guildId
          );

        if (
          previousState
            ?.voiceChannelId &&
          previousState
            .voiceChannelId !==
            voiceChannel.id
        ) {
          previousState.queue.length = 0;

          try {
            previousState.player.stop(
              true
            );
          } catch {
            // Player may already be idle.
          }
        }

        const state =
          getGuildState(
            interaction.guildId
          );

        await connectToVoiceChannel(
          voiceChannel,
          state
        );

        clearEmptyChannelTimer(
          state
        );

        await playJoinSound(interaction.guildId, state);

        const successContainer =
          new ContainerBuilder()
            .setAccentColor(
              COLORS.SUCCESS
            )

            .addTextDisplayComponents(
              (textDisplay) =>
                textDisplay.setContent(
                  [
                    "## 🔊 Voice Chat Connected",
                    `Successfully connected to <#${voiceChannel.id}>.`,
                  ].join("\n")
                )
            )

            .addSeparatorComponents(
              (separator) =>
                separator.setDivider(
                  true
                )
            )

            .addTextDisplayComponents(
              (textDisplay) =>
                textDisplay.setContent(
                  [
                    "### How it works",
                    "Messages posted in this voice channel's built-in chat will now be spoken aloud.",
                  ].join("\n")
                )
            );

        await interaction.editReply({
          components: [
            successContainer,
          ],
        });
      } catch (error) {
        console.error(
          "Failed to join voice channel:",
          error
        );

        const errorMessage =
          error instanceof Error
            ? error.message
            : String(error);

        const errorContainer =
          createV2Container({
            title:
              "Connection Failed",

            description:
              `I could not join <#${voiceChannel.id}>.\n\n` +
              `**Reason:** ${errorMessage}`,

            color: COLORS.ERROR,
          });

        await interaction.editReply({
          components: [
            errorContainer,
          ],
        });
      }

      return;
    }


    /* -----------------------------------------------------
       /LEAVE
    ----------------------------------------------------- */

    if (
      interaction.commandName ===
      "leave"
    ) {
      const state =
        guildStates.get(
          interaction.guildId
        );

      const connection =
        getVoiceConnection(
          interaction.guildId
        );

      if (!state && !connection) {
        return replyWithV2(
          interaction,
          {
            title:
              "Not Connected",

            description:
              "I am not currently connected to a voice channel.",

            color: COLORS.WARNING,
            ephemeral: true,
          }
        );
      }

      const connectedChannelId =
        connection
          ?.joinConfig
          ?.channelId ||
        state
          ?.voiceChannelId ||
        null;

      destroyGuildState(
        interaction.guildId
      );

      return replyWithV2(
        interaction,
        {
          title:
            "Voice Chat Disconnected",

          description:
            connectedChannelId
              ? `Disconnected from <#${connectedChannelId}>.`
              : "Disconnected from the voice channel.",

          color: COLORS.SUCCESS,
        }
      );
    }


    /* -----------------------------------------------------
       /LANGUAGE
    ----------------------------------------------------- */

    if (interaction.commandName === "language") {
      const scope = interaction.options.getString("scope") || "server";
      const { components } = generateLanguageMenuComponents(0, scope);
      const currentSelection = getGuildLanguageSelection(
        interaction.guildId,
        scope === "personal" ? interaction.user.id : null
      );
      const currentLabel = getLanguageVariantLabel(currentSelection.language, currentSelection.accent);

      const menuContainer = new ContainerBuilder()
        .setAccentColor(COLORS.INFO)
        .addTextDisplayComponents((td) => td.setContent(
          `## 🌐 Choose Bozos TTS Language\n${scope === "personal" ? "Choose your personal language and accent" : "Choose the server default language and accent"}. Current: **${currentLabel}**`
        ));

      return interaction.reply({
        components: [menuContainer, ...components],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    /* -----------------------------------------------------
       /VOLUME
    ----------------------------------------------------- */

    if (interaction.commandName === "volume") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyWithV2(interaction, { title: "Permission Required", description: "You need **Manage Server** to change Bozos volume.", color: COLORS.ERROR, ephemeral: true });
      }
      const percent = interaction.options.getInteger("percent", true);
      const settings = getGuildSettings(interaction.guildId);
      settings.volume = percent / 100;

      return replyWithV2(interaction, {
        title: "🔊 Volume Updated",
        description: `Bozos playback volume is now **${percent}%**.\n\nThis is the actual playback gain, independent of TTS generation loudness.`,
        color: COLORS.SUCCESS,
      });
    }

    /* -----------------------------------------------------
       /VOICE
    ----------------------------------------------------- */

    if (interaction.commandName === "voice") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyWithV2(interaction, { title: "Permission Required", description: "You need **Manage Server** to change the server voice preset.", color: COLORS.ERROR, ephemeral: true });
      }
      const preset = interaction.options.getString("preset", true);
      const settings = getGuildSettings(interaction.guildId);
      settings.voicePreset = preset;

      return replyWithV2(interaction, {
        title: "🎙️ Voice Preset Updated",
        description: `Bozos will use the **${VOICE_PRESETS[preset].label}** speech preset.\n\nThe default voice is deliberately neutral; the preset changes delivery rather than making speech artificially robotic.`,
        color: COLORS.SUCCESS,
      });
    }


    /* -----------------------------------------------------
       /SKIP
    ----------------------------------------------------- */

    if (interaction.commandName === "skip") {
      const state = guildStates.get(interaction.guildId);
      if (!state?.currentJob) {
        return replyWithV2(interaction, {
          title: "Nothing to Skip",
          description: "Bozos is not currently speaking a message.",
          color: COLORS.WARNING,
          ephemeral: true,
        });
      }

      state.skipRequested = true;
      try { state.player.stop(true); } catch {}
      return replyWithV2(interaction, {
        title: "⏭️ Skipped",
        description: "The current TTS message was skipped. The queue will continue.",
        color: COLORS.SUCCESS,
      });
    }

    /* -----------------------------------------------------
       /ANNOUNCEMENTS
    ----------------------------------------------------- */

    if (interaction.commandName === "announce") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyWithV2(interaction, { title: "Permission Required", description: "You need **Manage Server** to change announcement settings.", color: COLORS.ERROR, ephemeral: true });
      }
      const enabled = interaction.options.getBoolean("enabled", true);
      const settings = getGuildSettings(interaction.guildId);
      settings.announcements.enabled = enabled;

      return replyWithV2(interaction, {
        title: "📢 Voice Announcements Updated",
        description: `Join and leave announcements are now **${enabled ? "enabled" : "disabled"}**.\n\nThey are **off by default**.`,
        color: COLORS.SUCCESS,
      });
    }

    // SUPPORT
    if (interaction.commandName === "support") {
      const embed = new EmbedBuilder()
        .setColor("#ff69b4")
        .setAuthor({
          name: "Bozos TTS Support",
          iconURL: client.user.displayAvatarURL(),
        })
        .setTitle("🛠️ Need Help with Bozos TTS?")
        .setDescription(
          "If you need help, found a bug, or want to request a new feature, contact the bot support below. 💗"
        )
        .addFields(
          {
            name: "👑 Bot Developer",
            value: `<@${SUPPORT_USER_ID}>`,
            inline: true,
          },
          {
            name: "🤖 Bot Name",
            value: `**${client.user.username}**`,
            inline: true,
          },
          {
            name: "💡 What you can ask for",
            value:
              "• Bug fixes\n" +
              "• New command requests\n" +
              "• Server utility suggestions",
            inline: false,
          },
          {
            name: "📸 When reporting a bug",
            value:
              "Please send a screenshot of the error and explain what command caused it.",
            inline: false,
          }
        )
        .setThumbnail(client.user.displayAvatarURL())
        .setFooter({
          text: "Bozos TTS • Made with 💚",
          iconURL: client.user.displayAvatarURL(),
        })
        .setTimestamp();

      return interaction.reply({
        embeds: [embed],
        allowedMentions: {
          users: [SUPPORT_USER_ID],
        },
        flags: 64,
      });
    }


    /* -----------------------------------------------------
       /MAINTENANCE
    ----------------------------------------------------- */

    if (interaction.commandName === "maintenance") {
  // Replace this with your actual Discord User ID
  const OWNER_ID = "1458470088759054525";

  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({
      content: "❌ You are not authorized to use this command.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Point to the MP3 file you uploaded
  const MAINTENANCE_FILE = path.join(process.cwd(), "maintenance.mp3");

  // Safety check to make sure the file exists on the server
  if (!fs.existsSync(MAINTENANCE_FILE)) {
    return interaction.reply({
      content: "❌ Error: `maintenance.mp3` was not found in the project folder.",
      flags: MessageFlags.Ephemeral,
    });
  }

  let announcementCount = 0;

  for (const [guildId, state] of guildStates.entries()) {
    if (state.voiceChannelId) {
      // 1. Instantly delete all pending TTS messages in the queue
      state.queue.length = 0;
      
      // 2. Forcefully stop whatever TTS audio is currently playing
      state.player.stop(true);

      // 3. Play the custom Emma Watson MP3 directly
      try {
        const resource = createAudioResource(MAINTENANCE_FILE);
        state.player.play(resource);
        announcementCount++;
      } catch (error) {
        console.error(`[Maintenance] Failed to play audio in ${guildId}:`, error);
      }
    }
  }

  return interaction.reply({
    content: `📢 **Maintenance audio successfully blasted to ${announcementCount} active voice channel(s)!** Ongoing TTS was stopped.`,
    flags: MessageFlags.Ephemeral,
  });
}



// HELP
    if (interaction.commandName === "help") {
      return interaction.reply(buildHelpV2Payload("home"));
    }
  } // <-- Closes the main interaction handler function block (async (interaction) => { ... })
);
    

/* =========================================================
   VOICE-CHANNEL CHAT MESSAGE HANDLER
========================================================= */

client.on(
  Events.MessageCreate,
  async (message) => {
    if (
      !message.inGuild() ||
      message.author.bot ||
      message.system ||
      message.webhookId
    ) {
      return;
    }

    const state =
      guildStates.get(
        message.guildId
      );

    if (!state?.voiceChannelId) {
      return;
    }

    if (
      message.channelId !==
      state.voiceChannelId
    ) {
      return;
    }

    let member =
      message.member;

    if (!member) {
      member =
        await message.guild.members
          .fetch(
            message.author.id
          )
          .catch(() => null);
    }

    if (!member) {
      return;
    }

    if (
      member.voice.channelId !==
      state.voiceChannelId
    ) {
      return;
    }

    const cleanedMessage =
      prepareMessageForSpeech(
        message,
        message.author.id
      );

    if (!cleanedMessage) return;

    const speakerName = member.displayName;
    const queuedAt = performance.now();
    const includeSpeakerName = shouldAnnounceSpeaker(
      state,
      message.guild,
      member,
      queuedAt
    );

    const speechText = buildSpeechText(
      speakerName,
      cleanedMessage,
      message.guildId,
      message.author.id,
      includeSpeakerName
    );

    state.lastQueuedSpeakerId = message.author.id;
    state.lastQueuedSpeakerAt = queuedAt;

    state.queue.push({
      guild: message.guild,
      member,
      userId: message.author.id,
      voiceChannelId: state.voiceChannelId,
      speechText,
      messageReceivedAt: queuedAt,
      attempts: 0,
    });

    console.log(
      `[TTS] Queued message from ${speakerName}${includeSpeakerName ? " (speaker announced)" : ""}: ${cleanedMessage}`
    );

    void processGuildQueue(
      message.guildId,
      state
    );
  }
);


/* =========================================================
   VOICE ANNOUNCEMENTS
========================================================= */

function enqueueVoiceAnnouncement(guildId, state, member, event) {
  const settings = getGuildSettings(guildId);
  if (!settings.announcements.enabled || !state?.voiceChannelId) return;
  if (!member?.user || member.user.bot) return;

  const name = member.displayName || member.user.username;
  const speechText = event === "join"
    ? `${name} joined the voice channel.`
    : `${name} left the voice channel.`;

  state.queue.push({
    guild: member.guild,
    member,
    userId: member.id,
    voiceChannelId: state.voiceChannelId,
    speechText,
    messageReceivedAt: performance.now(),
    attempts: 0,
    isAnnouncement: true,
  });

  void processGuildQueue(guildId, state);
}

/* =========================================================
   VOICE STATE HANDLER
========================================================= */

client.on(
  Events.VoiceStateUpdate,
  (oldState, newState) => {
    const guildId = newState.guild.id;
    const botId = client.user?.id;

    if (newState.id === botId) {
      const state = guildStates.get(guildId);

      if (!newState.channelId) {
        if (!state || state.manualDisconnect) {
          destroyGuildState(guildId);
          return;
        }

        state.connection = null;
        scheduleVoiceReconnect(guildId);
        return;
      }

      if (state?.voiceChannelId && newState.channelId !== state.voiceChannelId) {
        console.log(`[Voice] Bot moved to another VC in guild ${guildId}; preserving queued jobs.`);
        state.voiceChannelId = newState.channelId;
        state.lastVoiceChannelId = newState.channelId;
        updateEmptyChannelTimer(guildId);
      }
      return;
    }

    const state = guildStates.get(guildId);
    if (!state?.voiceChannelId || newState.id === botId) return;

    const wasTracked = oldState.channelId === state.voiceChannelId;
    const isTracked = newState.channelId === state.voiceChannelId;

    if (!wasTracked && isTracked) {
      enqueueVoiceAnnouncement(guildId, state, newState.member, "join");
    } else if (wasTracked && !isTracked) {
      enqueueVoiceAnnouncement(guildId, state, oldState.member, "leave");
    }

    if (wasTracked || isTracked) updateEmptyChannelTimer(guildId);
  }
);


/* =========================================================
   ERROR HANDLING
========================================================= */

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "Unhandled promise rejection:",
      error
    );
  }
);


process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);


client.login(DISCORD_TOKEN);
