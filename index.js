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
  StreamType,
} from "@discordjs/voice";
import { createClient } from "@supabase/supabase-js";

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { PassThrough } from "node:stream";

import fs from "node:fs";
import path from "node:path";

// Inline lightweight Staff Platform shim for standalone Auto-Join testing.
// This removes the runtime dependency on ./staffPlatform.js while preserving
// the same method surface that the rest of index.js expects.
function createStaffPlatform() {
  const featureStates = new Map([
    ["tts_playback", true],
    ["voice_selection", true],
    ["pronunciation", true],
    ["announcements", true],
  ]);

  return {
    async start() {
      console.log("[Staff Platform Shim] Running in standalone test mode.");
    },
    stop() {},
    async syncSessions() {},
    async removeSession() {},
    isFeatureEnabled(featureKey) {
      return featureStates.get(String(featureKey)) !== false;
    },
    guildRestriction() {
      return null;
    },
    userRestriction() {
      return null;
    },
    featureDisabledText(featureKey, label = "This feature") {
      return `${label} is disabled${featureKey ? ` (${featureKey})` : ""}.`;
    },
    restrictionText(_restriction, subject = "This") {
      return `${subject} is currently restricted.`;
    },
  };
}


/* =========================================================
   CONFIGURATION
========================================================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const TTS_CHUNK_TARGET_CHARS = 360;
const TTS_CHUNK_MAX_CHARS = 480;
const EMPTY_CHANNEL_LEAVE_DELAY_MS = 180_000;
const SPEAKER_REPEAT_WINDOW_MS = 15_000;
const MAX_JOB_RETRIES = 3;
const RETRY_DELAY_MS = 750;
const MAX_VOLUME = 2.0;
const PREFETCH_BUFFER_BYTES = 2 * 1024 * 1024;
const LATENCY_SAMPLE_LIMIT = 200;
const JOIN_SOUND_FILE = path.join(process.cwd(), "bozos-tts-join.mp3");

// Natural speech defaults stay fixed; /voice changes only the neural speaker model.
// Discord-side volume is handled separately so loudness is consistent.
const TTS_VOICE_SETTINGS = {
  rate: "+4%",
  pitch: "+10Hz",
  volume: "+0%",
  outputFormat: OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS,
  saveSubtitles: false,
  timeout: 30_000,
};

// msedge-tts currently assumes every incoming Edge frame still has a live
// request entry. If a stream is cancelled (skip, disconnect, timeout), a late
// WebSocket frame can arrive after the library deletes that entry and throw
// `Cannot read properties of undefined (reading 'audio')`. Keep the upstream
// library untouched and make each instance tolerant of those late frames.
function createSafeMsEdgeTTS() {
  const edge = new MsEdgeTTS();
  const streams = edge?._streams;

  if (streams && typeof streams === "object") {
    const ignoredStream = {
      turnEnded: true,
      audio: { push() {}, destroy() {} },
      metadata: { push() {}, destroy() {} },
    };

    edge._streams = new Proxy(streams, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        return typeof property === "string" ? ignoredStream : undefined;
      },
    });
  }

  return edge;
}


// Permanent production voice catalog.
//
// Everything lives directly in index.js again. For every locale that existed
// in the earlier conservative two-voice catalog, those original two models
// remain first and in their original order; all additional production-verified
// voices are appended after them. New locales use the verified snapshot order.
//
// Voices remain categorized by supported language -> exact locale/accent.
// Production performs no voice discovery or verification requests.
const VERIFIED_VOICE_SNAPSHOT = Object.freeze({
  "verifiedAt": "2026-08-25T12:12:03.387Z",
  "verifiedVoices": 323,
  "locales": 142,
  "languageFamilies": 75,
  "excludedVoices": [
    {
      "voice": "yo-NG-AbebiNeural",
      "locale": "yo-NG",
      "gender": "Female"
    },
    {
      "voice": "yo-NG-AbeoNeural",
      "locale": "yo-NG",
      "gender": "Male"
    }
  ]
});

const VERIFIED_VOICES_BY_LANGUAGE = {
  "afrikaans": {
    "code": "af",
    "label": "Afrikaans",
    "defaultLocale": "af-ZA",
    "defaultVoice": "af-ZA-AdriNeural",
    "locales": {
      "af-ZA": [
        {
          "voice": "af-ZA-AdriNeural",
          "gender": "Female"
        },
        {
          "voice": "af-ZA-WillemNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "albanian": {
    "code": "sq",
    "label": "Albanian",
    "defaultLocale": "sq-AL",
    "defaultVoice": "sq-AL-AnilaNeural",
    "locales": {
      "sq-AL": [
        {
          "voice": "sq-AL-AnilaNeural",
          "gender": "Female"
        },
        {
          "voice": "sq-AL-IlirNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "amharic": {
    "code": "am",
    "label": "Amharic",
    "defaultLocale": "am-ET",
    "defaultVoice": "am-ET-MekdesNeural",
    "locales": {
      "am-ET": [
        {
          "voice": "am-ET-MekdesNeural",
          "gender": "Female"
        },
        {
          "voice": "am-ET-AmehaNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "arabic": {
    "code": "ar",
    "label": "Arabic",
    "defaultLocale": "ar-SA",
    "defaultVoice": "ar-SA-ZariyahNeural",
    "locales": {
      "ar-AE": [
        {
          "voice": "ar-AE-FatimaNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-AE-HamdanNeural",
          "gender": "Male"
        }
      ],
      "ar-BH": [
        {
          "voice": "ar-BH-LailaNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-BH-AliNeural",
          "gender": "Male"
        }
      ],
      "ar-DZ": [
        {
          "voice": "ar-DZ-AminaNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-DZ-IsmaelNeural",
          "gender": "Male"
        }
      ],
      "ar-EG": [
        {
          "voice": "ar-EG-SalmaNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-EG-ShakirNeural",
          "gender": "Male"
        }
      ],
      "ar-IQ": [
        {
          "voice": "ar-IQ-RanaNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-IQ-BasselNeural",
          "gender": "Male"
        }
      ],
      "ar-JO": [
        {
          "voice": "ar-JO-SanaNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-JO-TaimNeural",
          "gender": "Male"
        }
      ],
      "ar-KW": [
        {
          "voice": "ar-KW-NouraNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-KW-FahedNeural",
          "gender": "Male"
        }
      ],
      "ar-LB": [
        {
          "voice": "ar-LB-LaylaNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-LB-RamiNeural",
          "gender": "Male"
        }
      ],
      "ar-LY": [
        {
          "voice": "ar-LY-ImanNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-LY-OmarNeural",
          "gender": "Male"
        }
      ],
      "ar-MA": [
        {
          "voice": "ar-MA-MounaNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-MA-JamalNeural",
          "gender": "Male"
        }
      ],
      "ar-OM": [
        {
          "voice": "ar-OM-AyshaNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-OM-AbdullahNeural",
          "gender": "Male"
        }
      ],
      "ar-QA": [
        {
          "voice": "ar-QA-AmalNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-QA-MoazNeural",
          "gender": "Male"
        }
      ],
      "ar-SA": [
        {
          "voice": "ar-SA-ZariyahNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-SA-HamedNeural",
          "gender": "Male"
        }
      ],
      "ar-SY": [
        {
          "voice": "ar-SY-AmanyNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-SY-LaithNeural",
          "gender": "Male"
        }
      ],
      "ar-TN": [
        {
          "voice": "ar-TN-ReemNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-TN-HediNeural",
          "gender": "Male"
        }
      ],
      "ar-YE": [
        {
          "voice": "ar-YE-MaryamNeural",
          "gender": "Female"
        },
        {
          "voice": "ar-YE-SalehNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "azerbaijani": {
    "code": "az",
    "label": "Azerbaijani",
    "defaultLocale": "az-AZ",
    "defaultVoice": "az-AZ-BanuNeural",
    "locales": {
      "az-AZ": [
        {
          "voice": "az-AZ-BanuNeural",
          "gender": "Female"
        },
        {
          "voice": "az-AZ-BabekNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "bengali": {
    "code": "bn",
    "label": "Bengali",
    "defaultLocale": "bn-IN",
    "defaultVoice": "bn-IN-TanishaaNeural",
    "locales": {
      "bn-BD": [
        {
          "voice": "bn-BD-NabanitaNeural",
          "gender": "Female"
        },
        {
          "voice": "bn-BD-PradeepNeural",
          "gender": "Male"
        }
      ],
      "bn-IN": [
        {
          "voice": "bn-IN-TanishaaNeural",
          "gender": "Female"
        },
        {
          "voice": "bn-IN-BashkarNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "bosnian": {
    "code": "bs",
    "label": "Bosnian",
    "defaultLocale": "bs-BA",
    "defaultVoice": "bs-BA-VesnaNeural",
    "locales": {
      "bs-BA": [
        {
          "voice": "bs-BA-VesnaNeural",
          "gender": "Female"
        },
        {
          "voice": "bs-BA-GoranNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "bulgarian": {
    "code": "bg",
    "label": "Bulgarian",
    "defaultLocale": "bg-BG",
    "defaultVoice": "bg-BG-KalinaNeural",
    "locales": {
      "bg-BG": [
        {
          "voice": "bg-BG-KalinaNeural",
          "gender": "Female"
        },
        {
          "voice": "bg-BG-BorislavNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "burmese": {
    "code": "my",
    "label": "Burmese",
    "defaultLocale": "my-MM",
    "defaultVoice": "my-MM-NilarNeural",
    "locales": {
      "my-MM": [
        {
          "voice": "my-MM-NilarNeural",
          "gender": "Female"
        },
        {
          "voice": "my-MM-ThihaNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "catalan": {
    "code": "ca",
    "label": "Catalan",
    "defaultLocale": "ca-ES",
    "defaultVoice": "ca-ES-JoanaNeural",
    "locales": {
      "ca-ES": [
        {
          "voice": "ca-ES-JoanaNeural",
          "gender": "Female"
        },
        {
          "voice": "ca-ES-EnricNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "chinese": {
    "code": "zh",
    "label": "Chinese",
    "defaultLocale": "zh-CN",
    "defaultVoice": "zh-CN-XiaoxiaoNeural",
    "locales": {
      "zh-CN": [
        {
          "voice": "zh-CN-XiaoxiaoNeural",
          "gender": "Female"
        },
        {
          "voice": "zh-CN-YunxiNeural",
          "gender": "Male"
        },
        {
          "voice": "zh-CN-XiaoyiNeural",
          "gender": "Female"
        },
        {
          "voice": "zh-CN-YunjianNeural",
          "gender": "Male"
        },
        {
          "voice": "zh-CN-YunxiaNeural",
          "gender": "Male"
        },
        {
          "voice": "zh-CN-YunyangNeural",
          "gender": "Male"
        }
      ],
      "zh-CN-liaoning": [
        {
          "voice": "zh-CN-liaoning-XiaobeiNeural",
          "gender": "Female"
        }
      ],
      "zh-CN-shaanxi": [
        {
          "voice": "zh-CN-shaanxi-XiaoniNeural",
          "gender": "Female"
        }
      ],
      "zh-HK": [
        {
          "voice": "zh-HK-HiuGaaiNeural",
          "gender": "Female"
        },
        {
          "voice": "zh-HK-HiuMaanNeural",
          "gender": "Female"
        },
        {
          "voice": "zh-HK-WanLungNeural",
          "gender": "Male"
        }
      ],
      "zh-TW": [
        {
          "voice": "zh-TW-HsiaoChenNeural",
          "gender": "Female"
        },
        {
          "voice": "zh-TW-YunJheNeural",
          "gender": "Male"
        },
        {
          "voice": "zh-TW-HsiaoYuNeural",
          "gender": "Female"
        }
      ]
    }
  },
  "croatian": {
    "code": "hr",
    "label": "Croatian",
    "defaultLocale": "hr-HR",
    "defaultVoice": "hr-HR-GabrijelaNeural",
    "locales": {
      "hr-HR": [
        {
          "voice": "hr-HR-GabrijelaNeural",
          "gender": "Female"
        },
        {
          "voice": "hr-HR-SreckoNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "czech": {
    "code": "cs",
    "label": "Czech",
    "defaultLocale": "cs-CZ",
    "defaultVoice": "cs-CZ-VlastaNeural",
    "locales": {
      "cs-CZ": [
        {
          "voice": "cs-CZ-VlastaNeural",
          "gender": "Female"
        },
        {
          "voice": "cs-CZ-AntoninNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "danish": {
    "code": "da",
    "label": "Danish",
    "defaultLocale": "da-DK",
    "defaultVoice": "da-DK-ChristelNeural",
    "locales": {
      "da-DK": [
        {
          "voice": "da-DK-ChristelNeural",
          "gender": "Female"
        },
        {
          "voice": "da-DK-JeppeNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "dutch": {
    "code": "nl",
    "label": "Dutch",
    "defaultLocale": "nl-NL",
    "defaultVoice": "nl-NL-FennaNeural",
    "locales": {
      "nl-BE": [
        {
          "voice": "nl-BE-DenaNeural",
          "gender": "Female"
        },
        {
          "voice": "nl-BE-ArnaudNeural",
          "gender": "Male"
        }
      ],
      "nl-NL": [
        {
          "voice": "nl-NL-FennaNeural",
          "gender": "Female"
        },
        {
          "voice": "nl-NL-MaartenNeural",
          "gender": "Male"
        },
        {
          "voice": "nl-NL-ColetteNeural",
          "gender": "Female"
        }
      ]
    }
  },
  "english": {
    "code": "en",
    "label": "English",
    "defaultLocale": "en-US",
    "defaultVoice": "en-US-JennyNeural",
    "locales": {
      "en-AU": [
        {
          "voice": "en-AU-NatashaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-AU-WilliamNeural",
          "gender": "Male"
        },
        {
          "voice": "en-AU-WilliamMultilingualNeural",
          "gender": "Male"
        }
      ],
      "en-CA": [
        {
          "voice": "en-CA-ClaraNeural",
          "gender": "Female"
        },
        {
          "voice": "en-CA-LiamNeural",
          "gender": "Male"
        }
      ],
      "en-GB": [
        {
          "voice": "en-GB-LibbyNeural",
          "gender": "Female"
        },
        {
          "voice": "en-GB-RyanNeural",
          "gender": "Male"
        },
        {
          "voice": "en-GB-MaisieNeural",
          "gender": "Female"
        },
        {
          "voice": "en-GB-SoniaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-GB-ThomasNeural",
          "gender": "Male"
        }
      ],
      "en-HK": [
        {
          "voice": "en-HK-YanNeural",
          "gender": "Female"
        },
        {
          "voice": "en-HK-SamNeural",
          "gender": "Male"
        }
      ],
      "en-IE": [
        {
          "voice": "en-IE-EmilyNeural",
          "gender": "Female"
        },
        {
          "voice": "en-IE-ConnorNeural",
          "gender": "Male"
        }
      ],
      "en-IN": [
        {
          "voice": "en-IN-NeerjaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-IN-PrabhatNeural",
          "gender": "Male"
        },
        {
          "voice": "en-IN-NeerjaExpressiveNeural",
          "gender": "Female"
        }
      ],
      "en-KE": [
        {
          "voice": "en-KE-AsiliaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-KE-ChilembaNeural",
          "gender": "Male"
        }
      ],
      "en-NG": [
        {
          "voice": "en-NG-EzinneNeural",
          "gender": "Female"
        },
        {
          "voice": "en-NG-AbeoNeural",
          "gender": "Male"
        }
      ],
      "en-NZ": [
        {
          "voice": "en-NZ-MollyNeural",
          "gender": "Female"
        },
        {
          "voice": "en-NZ-MitchellNeural",
          "gender": "Male"
        }
      ],
      "en-PH": [
        {
          "voice": "en-PH-RosaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-PH-JamesNeural",
          "gender": "Male"
        }
      ],
      "en-SG": [
        {
          "voice": "en-SG-LunaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-SG-WayneNeural",
          "gender": "Male"
        }
      ],
      "en-TZ": [
        {
          "voice": "en-TZ-ImaniNeural",
          "gender": "Female"
        },
        {
          "voice": "en-TZ-ElimuNeural",
          "gender": "Male"
        }
      ],
      "en-US": [
        {
          "voice": "en-US-JennyNeural",
          "gender": "Female"
        },
        {
          "voice": "en-US-GuyNeural",
          "gender": "Male"
        },
        {
          "voice": "en-US-AnaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-US-AriaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-US-AvaMultilingualNeural",
          "gender": "Female"
        },
        {
          "voice": "en-US-AvaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-US-EmmaMultilingualNeural",
          "gender": "Female"
        },
        {
          "voice": "en-US-EmmaNeural",
          "gender": "Female"
        },
        {
          "voice": "en-US-MichelleNeural",
          "gender": "Female"
        },
        {
          "voice": "en-US-AndrewMultilingualNeural",
          "gender": "Male"
        },
        {
          "voice": "en-US-AndrewNeural",
          "gender": "Male"
        },
        {
          "voice": "en-US-BrianMultilingualNeural",
          "gender": "Male"
        },
        {
          "voice": "en-US-BrianNeural",
          "gender": "Male"
        },
        {
          "voice": "en-US-ChristopherNeural",
          "gender": "Male"
        },
        {
          "voice": "en-US-EricNeural",
          "gender": "Male"
        },
        {
          "voice": "en-US-RogerNeural",
          "gender": "Male"
        },
        {
          "voice": "en-US-SteffanNeural",
          "gender": "Male"
        }
      ],
      "en-ZA": [
        {
          "voice": "en-ZA-LeahNeural",
          "gender": "Female"
        },
        {
          "voice": "en-ZA-LukeNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "estonian": {
    "code": "et",
    "label": "Estonian",
    "defaultLocale": "et-EE",
    "defaultVoice": "et-EE-AnuNeural",
    "locales": {
      "et-EE": [
        {
          "voice": "et-EE-AnuNeural",
          "gender": "Female"
        },
        {
          "voice": "et-EE-KertNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "filipino": {
    "code": "fil",
    "label": "Filipino",
    "defaultLocale": "fil-PH",
    "defaultVoice": "fil-PH-BlessicaNeural",
    "locales": {
      "fil-PH": [
        {
          "voice": "fil-PH-BlessicaNeural",
          "gender": "Female"
        },
        {
          "voice": "fil-PH-AngeloNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "finnish": {
    "code": "fi",
    "label": "Finnish",
    "defaultLocale": "fi-FI",
    "defaultVoice": "fi-FI-NooraNeural",
    "locales": {
      "fi-FI": [
        {
          "voice": "fi-FI-NooraNeural",
          "gender": "Female"
        },
        {
          "voice": "fi-FI-HarriNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "french": {
    "code": "fr",
    "label": "French",
    "defaultLocale": "fr-FR",
    "defaultVoice": "fr-FR-DeniseNeural",
    "locales": {
      "fr-BE": [
        {
          "voice": "fr-BE-CharlineNeural",
          "gender": "Female"
        },
        {
          "voice": "fr-BE-GerardNeural",
          "gender": "Male"
        }
      ],
      "fr-CA": [
        {
          "voice": "fr-CA-SylvieNeural",
          "gender": "Female"
        },
        {
          "voice": "fr-CA-JeanNeural",
          "gender": "Male"
        },
        {
          "voice": "fr-CA-AntoineNeural",
          "gender": "Male"
        },
        {
          "voice": "fr-CA-ThierryNeural",
          "gender": "Male"
        }
      ],
      "fr-CH": [
        {
          "voice": "fr-CH-ArianeNeural",
          "gender": "Female"
        },
        {
          "voice": "fr-CH-FabriceNeural",
          "gender": "Male"
        }
      ],
      "fr-FR": [
        {
          "voice": "fr-FR-DeniseNeural",
          "gender": "Female"
        },
        {
          "voice": "fr-FR-HenriNeural",
          "gender": "Male"
        },
        {
          "voice": "fr-FR-EloiseNeural",
          "gender": "Female"
        },
        {
          "voice": "fr-FR-VivienneMultilingualNeural",
          "gender": "Female"
        },
        {
          "voice": "fr-FR-RemyMultilingualNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "galician": {
    "code": "gl",
    "label": "Galician",
    "defaultLocale": "gl-ES",
    "defaultVoice": "gl-ES-SabelaNeural",
    "locales": {
      "gl-ES": [
        {
          "voice": "gl-ES-SabelaNeural",
          "gender": "Female"
        },
        {
          "voice": "gl-ES-RoiNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "georgian": {
    "code": "ka",
    "label": "Georgian",
    "defaultLocale": "ka-GE",
    "defaultVoice": "ka-GE-EkaNeural",
    "locales": {
      "ka-GE": [
        {
          "voice": "ka-GE-EkaNeural",
          "gender": "Female"
        },
        {
          "voice": "ka-GE-GiorgiNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "german": {
    "code": "de",
    "label": "German",
    "defaultLocale": "de-DE",
    "defaultVoice": "de-DE-KatjaNeural",
    "locales": {
      "de-AT": [
        {
          "voice": "de-AT-IngridNeural",
          "gender": "Female"
        },
        {
          "voice": "de-AT-JonasNeural",
          "gender": "Male"
        }
      ],
      "de-CH": [
        {
          "voice": "de-CH-LeniNeural",
          "gender": "Female"
        },
        {
          "voice": "de-CH-JanNeural",
          "gender": "Male"
        }
      ],
      "de-DE": [
        {
          "voice": "de-DE-KatjaNeural",
          "gender": "Female"
        },
        {
          "voice": "de-DE-ConradNeural",
          "gender": "Male"
        },
        {
          "voice": "de-DE-AmalaNeural",
          "gender": "Female"
        },
        {
          "voice": "de-DE-SeraphinaMultilingualNeural",
          "gender": "Female"
        },
        {
          "voice": "de-DE-FlorianMultilingualNeural",
          "gender": "Male"
        },
        {
          "voice": "de-DE-KillianNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "greek": {
    "code": "el",
    "label": "Greek",
    "defaultLocale": "el-GR",
    "defaultVoice": "el-GR-AthinaNeural",
    "locales": {
      "el-GR": [
        {
          "voice": "el-GR-AthinaNeural",
          "gender": "Female"
        },
        {
          "voice": "el-GR-NestorasNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "gujarati": {
    "code": "gu",
    "label": "Gujarati",
    "defaultLocale": "gu-IN",
    "defaultVoice": "gu-IN-DhwaniNeural",
    "locales": {
      "gu-IN": [
        {
          "voice": "gu-IN-DhwaniNeural",
          "gender": "Female"
        },
        {
          "voice": "gu-IN-NiranjanNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "hebrew": {
    "code": "he",
    "label": "Hebrew",
    "defaultLocale": "he-IL",
    "defaultVoice": "he-IL-HilaNeural",
    "locales": {
      "he-IL": [
        {
          "voice": "he-IL-HilaNeural",
          "gender": "Female"
        },
        {
          "voice": "he-IL-AvriNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "hindi": {
    "code": "hi",
    "label": "Hindi",
    "defaultLocale": "hi-IN",
    "defaultVoice": "hi-IN-SwaraNeural",
    "locales": {
      "hi-IN": [
        {
          "voice": "hi-IN-SwaraNeural",
          "gender": "Female"
        },
        {
          "voice": "hi-IN-MadhurNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "hungarian": {
    "code": "hu",
    "label": "Hungarian",
    "defaultLocale": "hu-HU",
    "defaultVoice": "hu-HU-NoemiNeural",
    "locales": {
      "hu-HU": [
        {
          "voice": "hu-HU-NoemiNeural",
          "gender": "Female"
        },
        {
          "voice": "hu-HU-TamasNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "icelandic": {
    "code": "is",
    "label": "Icelandic",
    "defaultLocale": "is-IS",
    "defaultVoice": "is-IS-GudrunNeural",
    "locales": {
      "is-IS": [
        {
          "voice": "is-IS-GudrunNeural",
          "gender": "Female"
        },
        {
          "voice": "is-IS-GunnarNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "indonesian": {
    "code": "id",
    "label": "Indonesian",
    "defaultLocale": "id-ID",
    "defaultVoice": "id-ID-GadisNeural",
    "locales": {
      "id-ID": [
        {
          "voice": "id-ID-GadisNeural",
          "gender": "Female"
        },
        {
          "voice": "id-ID-ArdiNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "inuktitut": {
    "code": "iu",
    "label": "Inuktitut",
    "defaultLocale": "iu-Cans-CA",
    "defaultVoice": "iu-Cans-CA-SiqiniqNeural",
    "locales": {
      "iu-Cans-CA": [
        {
          "voice": "iu-Cans-CA-SiqiniqNeural",
          "gender": "Female"
        },
        {
          "voice": "iu-Cans-CA-TaqqiqNeural",
          "gender": "Male"
        }
      ],
      "iu-Latn-CA": [
        {
          "voice": "iu-Latn-CA-SiqiniqNeural",
          "gender": "Female"
        },
        {
          "voice": "iu-Latn-CA-TaqqiqNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "irish": {
    "code": "ga",
    "label": "Irish",
    "defaultLocale": "ga-IE",
    "defaultVoice": "ga-IE-OrlaNeural",
    "locales": {
      "ga-IE": [
        {
          "voice": "ga-IE-OrlaNeural",
          "gender": "Female"
        },
        {
          "voice": "ga-IE-ColmNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "italian": {
    "code": "it",
    "label": "Italian",
    "defaultLocale": "it-IT",
    "defaultVoice": "it-IT-ElsaNeural",
    "locales": {
      "it-IT": [
        {
          "voice": "it-IT-ElsaNeural",
          "gender": "Female"
        },
        {
          "voice": "it-IT-DiegoNeural",
          "gender": "Male"
        },
        {
          "voice": "it-IT-IsabellaNeural",
          "gender": "Female"
        },
        {
          "voice": "it-IT-GiuseppeMultilingualNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "japanese": {
    "code": "ja",
    "label": "Japanese",
    "defaultLocale": "ja-JP",
    "defaultVoice": "ja-JP-NanamiNeural",
    "locales": {
      "ja-JP": [
        {
          "voice": "ja-JP-NanamiNeural",
          "gender": "Female"
        },
        {
          "voice": "ja-JP-KeitaNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "javanese": {
    "code": "jv",
    "label": "Javanese",
    "defaultLocale": "jv-ID",
    "defaultVoice": "jv-ID-SitiNeural",
    "locales": {
      "jv-ID": [
        {
          "voice": "jv-ID-SitiNeural",
          "gender": "Female"
        },
        {
          "voice": "jv-ID-DimasNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "kannada": {
    "code": "kn",
    "label": "Kannada",
    "defaultLocale": "kn-IN",
    "defaultVoice": "kn-IN-SapnaNeural",
    "locales": {
      "kn-IN": [
        {
          "voice": "kn-IN-SapnaNeural",
          "gender": "Female"
        },
        {
          "voice": "kn-IN-GaganNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "kazakh": {
    "code": "kk",
    "label": "Kazakh",
    "defaultLocale": "kk-KZ",
    "defaultVoice": "kk-KZ-AigulNeural",
    "locales": {
      "kk-KZ": [
        {
          "voice": "kk-KZ-AigulNeural",
          "gender": "Female"
        },
        {
          "voice": "kk-KZ-DauletNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "khmer": {
    "code": "km",
    "label": "Khmer",
    "defaultLocale": "km-KH",
    "defaultVoice": "km-KH-SreymomNeural",
    "locales": {
      "km-KH": [
        {
          "voice": "km-KH-SreymomNeural",
          "gender": "Female"
        },
        {
          "voice": "km-KH-PisethNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "korean": {
    "code": "ko",
    "label": "Korean",
    "defaultLocale": "ko-KR",
    "defaultVoice": "ko-KR-SunHiNeural",
    "locales": {
      "ko-KR": [
        {
          "voice": "ko-KR-SunHiNeural",
          "gender": "Female"
        },
        {
          "voice": "ko-KR-InJoonNeural",
          "gender": "Male"
        },
        {
          "voice": "ko-KR-HyunsuMultilingualNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "lao": {
    "code": "lo",
    "label": "Lao",
    "defaultLocale": "lo-LA",
    "defaultVoice": "lo-LA-KeomanyNeural",
    "locales": {
      "lo-LA": [
        {
          "voice": "lo-LA-KeomanyNeural",
          "gender": "Female"
        },
        {
          "voice": "lo-LA-ChanthavongNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "latvian": {
    "code": "lv",
    "label": "Latvian",
    "defaultLocale": "lv-LV",
    "defaultVoice": "lv-LV-EveritaNeural",
    "locales": {
      "lv-LV": [
        {
          "voice": "lv-LV-EveritaNeural",
          "gender": "Female"
        },
        {
          "voice": "lv-LV-NilsNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "lithuanian": {
    "code": "lt",
    "label": "Lithuanian",
    "defaultLocale": "lt-LT",
    "defaultVoice": "lt-LT-OnaNeural",
    "locales": {
      "lt-LT": [
        {
          "voice": "lt-LT-OnaNeural",
          "gender": "Female"
        },
        {
          "voice": "lt-LT-LeonasNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "macedonian": {
    "code": "mk",
    "label": "Macedonian",
    "defaultLocale": "mk-MK",
    "defaultVoice": "mk-MK-MarijaNeural",
    "locales": {
      "mk-MK": [
        {
          "voice": "mk-MK-MarijaNeural",
          "gender": "Female"
        },
        {
          "voice": "mk-MK-AleksandarNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "malay": {
    "code": "ms",
    "label": "Malay",
    "defaultLocale": "ms-MY",
    "defaultVoice": "ms-MY-YasminNeural",
    "locales": {
      "ms-MY": [
        {
          "voice": "ms-MY-YasminNeural",
          "gender": "Female"
        },
        {
          "voice": "ms-MY-OsmanNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "malayalam": {
    "code": "ml",
    "label": "Malayalam",
    "defaultLocale": "ml-IN",
    "defaultVoice": "ml-IN-SobhanaNeural",
    "locales": {
      "ml-IN": [
        {
          "voice": "ml-IN-SobhanaNeural",
          "gender": "Female"
        },
        {
          "voice": "ml-IN-MidhunNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "maltese": {
    "code": "mt",
    "label": "Maltese",
    "defaultLocale": "mt-MT",
    "defaultVoice": "mt-MT-GraceNeural",
    "locales": {
      "mt-MT": [
        {
          "voice": "mt-MT-GraceNeural",
          "gender": "Female"
        },
        {
          "voice": "mt-MT-JosephNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "marathi": {
    "code": "mr",
    "label": "Marathi",
    "defaultLocale": "mr-IN",
    "defaultVoice": "mr-IN-AarohiNeural",
    "locales": {
      "mr-IN": [
        {
          "voice": "mr-IN-AarohiNeural",
          "gender": "Female"
        },
        {
          "voice": "mr-IN-ManoharNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "mongolian": {
    "code": "mn",
    "label": "Mongolian",
    "defaultLocale": "mn-MN",
    "defaultVoice": "mn-MN-YesuiNeural",
    "locales": {
      "mn-MN": [
        {
          "voice": "mn-MN-YesuiNeural",
          "gender": "Female"
        },
        {
          "voice": "mn-MN-BataaNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "nepali": {
    "code": "ne",
    "label": "Nepali",
    "defaultLocale": "ne-NP",
    "defaultVoice": "ne-NP-HemkalaNeural",
    "locales": {
      "ne-NP": [
        {
          "voice": "ne-NP-HemkalaNeural",
          "gender": "Female"
        },
        {
          "voice": "ne-NP-SagarNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "norwegian": {
    "code": "nb",
    "label": "Norwegian",
    "defaultLocale": "nb-NO",
    "defaultVoice": "nb-NO-PernilleNeural",
    "locales": {
      "nb-NO": [
        {
          "voice": "nb-NO-PernilleNeural",
          "gender": "Female"
        },
        {
          "voice": "nb-NO-FinnNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "pashto": {
    "code": "ps",
    "label": "Pashto",
    "defaultLocale": "ps-AF",
    "defaultVoice": "ps-AF-LatifaNeural",
    "locales": {
      "ps-AF": [
        {
          "voice": "ps-AF-LatifaNeural",
          "gender": "Female"
        },
        {
          "voice": "ps-AF-GulNawazNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "persian": {
    "code": "fa",
    "label": "Persian",
    "defaultLocale": "fa-IR",
    "defaultVoice": "fa-IR-DilaraNeural",
    "locales": {
      "fa-IR": [
        {
          "voice": "fa-IR-DilaraNeural",
          "gender": "Female"
        },
        {
          "voice": "fa-IR-FaridNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "polish": {
    "code": "pl",
    "label": "Polish",
    "defaultLocale": "pl-PL",
    "defaultVoice": "pl-PL-ZofiaNeural",
    "locales": {
      "pl-PL": [
        {
          "voice": "pl-PL-ZofiaNeural",
          "gender": "Female"
        },
        {
          "voice": "pl-PL-MarekNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "portuguese": {
    "code": "pt",
    "label": "Portuguese",
    "defaultLocale": "pt-BR",
    "defaultVoice": "pt-BR-FranciscaNeural",
    "locales": {
      "pt-BR": [
        {
          "voice": "pt-BR-FranciscaNeural",
          "gender": "Female"
        },
        {
          "voice": "pt-BR-AntonioNeural",
          "gender": "Male"
        },
        {
          "voice": "pt-BR-ThalitaMultilingualNeural",
          "gender": "Female"
        }
      ],
      "pt-PT": [
        {
          "voice": "pt-PT-RaquelNeural",
          "gender": "Female"
        },
        {
          "voice": "pt-PT-DuarteNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "romanian": {
    "code": "ro",
    "label": "Romanian",
    "defaultLocale": "ro-RO",
    "defaultVoice": "ro-RO-AlinaNeural",
    "locales": {
      "ro-RO": [
        {
          "voice": "ro-RO-AlinaNeural",
          "gender": "Female"
        },
        {
          "voice": "ro-RO-EmilNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "russian": {
    "code": "ru",
    "label": "Russian",
    "defaultLocale": "ru-RU",
    "defaultVoice": "ru-RU-SvetlanaNeural",
    "locales": {
      "ru-RU": [
        {
          "voice": "ru-RU-SvetlanaNeural",
          "gender": "Female"
        },
        {
          "voice": "ru-RU-DmitryNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "serbian": {
    "code": "sr",
    "label": "Serbian",
    "defaultLocale": "sr-RS",
    "defaultVoice": "sr-RS-SophieNeural",
    "locales": {
      "sr-RS": [
        {
          "voice": "sr-RS-SophieNeural",
          "gender": "Female"
        },
        {
          "voice": "sr-RS-NicholasNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "sinhala": {
    "code": "si",
    "label": "Sinhala",
    "defaultLocale": "si-LK",
    "defaultVoice": "si-LK-ThiliniNeural",
    "locales": {
      "si-LK": [
        {
          "voice": "si-LK-ThiliniNeural",
          "gender": "Female"
        },
        {
          "voice": "si-LK-SameeraNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "slovak": {
    "code": "sk",
    "label": "Slovak",
    "defaultLocale": "sk-SK",
    "defaultVoice": "sk-SK-ViktoriaNeural",
    "locales": {
      "sk-SK": [
        {
          "voice": "sk-SK-ViktoriaNeural",
          "gender": "Female"
        },
        {
          "voice": "sk-SK-LukasNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "slovenian": {
    "code": "sl",
    "label": "Slovenian",
    "defaultLocale": "sl-SI",
    "defaultVoice": "sl-SI-PetraNeural",
    "locales": {
      "sl-SI": [
        {
          "voice": "sl-SI-PetraNeural",
          "gender": "Female"
        },
        {
          "voice": "sl-SI-RokNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "somali": {
    "code": "so",
    "label": "Somali",
    "defaultLocale": "so-SO",
    "defaultVoice": "so-SO-UbaxNeural",
    "locales": {
      "so-SO": [
        {
          "voice": "so-SO-UbaxNeural",
          "gender": "Female"
        },
        {
          "voice": "so-SO-MuuseNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "spanish": {
    "code": "es",
    "label": "Spanish",
    "defaultLocale": "es-ES",
    "defaultVoice": "es-ES-ElviraNeural",
    "locales": {
      "es-AR": [
        {
          "voice": "es-AR-ElenaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-AR-TomasNeural",
          "gender": "Male"
        }
      ],
      "es-BO": [
        {
          "voice": "es-BO-SofiaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-BO-MarceloNeural",
          "gender": "Male"
        }
      ],
      "es-CL": [
        {
          "voice": "es-CL-CatalinaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-CL-LorenzoNeural",
          "gender": "Male"
        }
      ],
      "es-CO": [
        {
          "voice": "es-CO-SalomeNeural",
          "gender": "Female"
        },
        {
          "voice": "es-CO-GonzaloNeural",
          "gender": "Male"
        }
      ],
      "es-CR": [
        {
          "voice": "es-CR-MariaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-CR-JuanNeural",
          "gender": "Male"
        }
      ],
      "es-CU": [
        {
          "voice": "es-CU-BelkysNeural",
          "gender": "Female"
        },
        {
          "voice": "es-CU-ManuelNeural",
          "gender": "Male"
        }
      ],
      "es-DO": [
        {
          "voice": "es-DO-RamonaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-DO-EmilioNeural",
          "gender": "Male"
        }
      ],
      "es-EC": [
        {
          "voice": "es-EC-AndreaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-EC-LuisNeural",
          "gender": "Male"
        }
      ],
      "es-ES": [
        {
          "voice": "es-ES-ElviraNeural",
          "gender": "Female"
        },
        {
          "voice": "es-ES-AlvaroNeural",
          "gender": "Male"
        },
        {
          "voice": "es-ES-XimenaNeural",
          "gender": "Female"
        }
      ],
      "es-GQ": [
        {
          "voice": "es-GQ-TeresaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-GQ-JavierNeural",
          "gender": "Male"
        }
      ],
      "es-GT": [
        {
          "voice": "es-GT-MartaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-GT-AndresNeural",
          "gender": "Male"
        }
      ],
      "es-HN": [
        {
          "voice": "es-HN-KarlaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-HN-CarlosNeural",
          "gender": "Male"
        }
      ],
      "es-MX": [
        {
          "voice": "es-MX-DaliaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-MX-JorgeNeural",
          "gender": "Male"
        }
      ],
      "es-NI": [
        {
          "voice": "es-NI-YolandaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-NI-FedericoNeural",
          "gender": "Male"
        }
      ],
      "es-PA": [
        {
          "voice": "es-PA-MargaritaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-PA-RobertoNeural",
          "gender": "Male"
        }
      ],
      "es-PE": [
        {
          "voice": "es-PE-CamilaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-PE-AlexNeural",
          "gender": "Male"
        }
      ],
      "es-PR": [
        {
          "voice": "es-PR-KarinaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-PR-VictorNeural",
          "gender": "Male"
        }
      ],
      "es-PY": [
        {
          "voice": "es-PY-TaniaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-PY-MarioNeural",
          "gender": "Male"
        }
      ],
      "es-SV": [
        {
          "voice": "es-SV-LorenaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-SV-RodrigoNeural",
          "gender": "Male"
        }
      ],
      "es-US": [
        {
          "voice": "es-US-PalomaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-US-AlonsoNeural",
          "gender": "Male"
        }
      ],
      "es-UY": [
        {
          "voice": "es-UY-ValentinaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-UY-MateoNeural",
          "gender": "Male"
        }
      ],
      "es-VE": [
        {
          "voice": "es-VE-PaolaNeural",
          "gender": "Female"
        },
        {
          "voice": "es-VE-SebastianNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "sundanese": {
    "code": "su",
    "label": "Sundanese",
    "defaultLocale": "su-ID",
    "defaultVoice": "su-ID-TutiNeural",
    "locales": {
      "su-ID": [
        {
          "voice": "su-ID-TutiNeural",
          "gender": "Female"
        },
        {
          "voice": "su-ID-JajangNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "swahili": {
    "code": "sw",
    "label": "Swahili",
    "defaultLocale": "sw-KE",
    "defaultVoice": "sw-KE-ZuriNeural",
    "locales": {
      "sw-KE": [
        {
          "voice": "sw-KE-ZuriNeural",
          "gender": "Female"
        },
        {
          "voice": "sw-KE-RafikiNeural",
          "gender": "Male"
        }
      ],
      "sw-TZ": [
        {
          "voice": "sw-TZ-RehemaNeural",
          "gender": "Female"
        },
        {
          "voice": "sw-TZ-DaudiNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "swedish": {
    "code": "sv",
    "label": "Swedish",
    "defaultLocale": "sv-SE",
    "defaultVoice": "sv-SE-SofieNeural",
    "locales": {
      "sv-SE": [
        {
          "voice": "sv-SE-SofieNeural",
          "gender": "Female"
        },
        {
          "voice": "sv-SE-MattiasNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "tamil": {
    "code": "ta",
    "label": "Tamil",
    "defaultLocale": "ta-IN",
    "defaultVoice": "ta-IN-PallaviNeural",
    "locales": {
      "ta-IN": [
        {
          "voice": "ta-IN-PallaviNeural",
          "gender": "Female"
        },
        {
          "voice": "ta-IN-ValluvarNeural",
          "gender": "Male"
        }
      ],
      "ta-LK": [
        {
          "voice": "ta-LK-SaranyaNeural",
          "gender": "Female"
        },
        {
          "voice": "ta-LK-KumarNeural",
          "gender": "Male"
        }
      ],
      "ta-MY": [
        {
          "voice": "ta-MY-KaniNeural",
          "gender": "Female"
        },
        {
          "voice": "ta-MY-SuryaNeural",
          "gender": "Male"
        }
      ],
      "ta-SG": [
        {
          "voice": "ta-SG-VenbaNeural",
          "gender": "Female"
        },
        {
          "voice": "ta-SG-AnbuNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "telugu": {
    "code": "te",
    "label": "Telugu",
    "defaultLocale": "te-IN",
    "defaultVoice": "te-IN-ShrutiNeural",
    "locales": {
      "te-IN": [
        {
          "voice": "te-IN-ShrutiNeural",
          "gender": "Female"
        },
        {
          "voice": "te-IN-MohanNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "thai": {
    "code": "th",
    "label": "Thai",
    "defaultLocale": "th-TH",
    "defaultVoice": "th-TH-PremwadeeNeural",
    "locales": {
      "th-TH": [
        {
          "voice": "th-TH-PremwadeeNeural",
          "gender": "Female"
        },
        {
          "voice": "th-TH-NiwatNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "turkish": {
    "code": "tr",
    "label": "Turkish",
    "defaultLocale": "tr-TR",
    "defaultVoice": "tr-TR-EmelNeural",
    "locales": {
      "tr-TR": [
        {
          "voice": "tr-TR-EmelNeural",
          "gender": "Female"
        },
        {
          "voice": "tr-TR-AhmetNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "ukrainian": {
    "code": "uk",
    "label": "Ukrainian",
    "defaultLocale": "uk-UA",
    "defaultVoice": "uk-UA-PolinaNeural",
    "locales": {
      "uk-UA": [
        {
          "voice": "uk-UA-PolinaNeural",
          "gender": "Female"
        },
        {
          "voice": "uk-UA-OstapNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "urdu": {
    "code": "ur",
    "label": "Urdu",
    "defaultLocale": "ur-PK",
    "defaultVoice": "ur-PK-UzmaNeural",
    "locales": {
      "ur-IN": [
        {
          "voice": "ur-IN-GulNeural",
          "gender": "Female"
        },
        {
          "voice": "ur-IN-SalmanNeural",
          "gender": "Male"
        }
      ],
      "ur-PK": [
        {
          "voice": "ur-PK-UzmaNeural",
          "gender": "Female"
        },
        {
          "voice": "ur-PK-AsadNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "uzbek": {
    "code": "uz",
    "label": "Uzbek",
    "defaultLocale": "uz-UZ",
    "defaultVoice": "uz-UZ-MadinaNeural",
    "locales": {
      "uz-UZ": [
        {
          "voice": "uz-UZ-MadinaNeural",
          "gender": "Female"
        },
        {
          "voice": "uz-UZ-SardorNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "vietnamese": {
    "code": "vi",
    "label": "Vietnamese",
    "defaultLocale": "vi-VN",
    "defaultVoice": "vi-VN-HoaiMyNeural",
    "locales": {
      "vi-VN": [
        {
          "voice": "vi-VN-HoaiMyNeural",
          "gender": "Female"
        },
        {
          "voice": "vi-VN-NamMinhNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "welsh": {
    "code": "cy",
    "label": "Welsh",
    "defaultLocale": "cy-GB",
    "defaultVoice": "cy-GB-NiaNeural",
    "locales": {
      "cy-GB": [
        {
          "voice": "cy-GB-NiaNeural",
          "gender": "Female"
        },
        {
          "voice": "cy-GB-AledNeural",
          "gender": "Male"
        }
      ]
    }
  },
  "zulu": {
    "code": "zu",
    "label": "Zulu",
    "defaultLocale": "zu-ZA",
    "defaultVoice": "zu-ZA-ThandoNeural",
    "locales": {
      "zu-ZA": [
        {
          "voice": "zu-ZA-ThandoNeural",
          "gender": "Female"
        },
        {
          "voice": "zu-ZA-ThembaNeural",
          "gender": "Male"
        }
      ]
    }
  }
};

const STATIC_VOICE_MODELS_BY_LOCALE = new Map();
const STATIC_LANGUAGE_KEY_BY_LOCALE = new Map();
const STATIC_LOCALE_BY_VOICE = new Map();

for (const [languageKey, language] of Object.entries(VERIFIED_VOICES_BY_LANGUAGE)) {
  for (const [locale, entries] of Object.entries(language.locales || {})) {
    const models = (entries || []).map((entry) => ({
      ...entry,
      locale,
      languageKey,
    }));

    STATIC_VOICE_MODELS_BY_LOCALE.set(locale, models);
    STATIC_LANGUAGE_KEY_BY_LOCALE.set(locale, languageKey);
    for (const model of models) STATIC_LOCALE_BY_VOICE.set(model.voice, locale);
  }
}

const STATIC_VERIFIED_VOICE_COUNT = [...STATIC_VOICE_MODELS_BY_LOCALE.values()]
  .reduce((sum, entries) => sum + entries.length, 0);

if (
  STATIC_VERIFIED_VOICE_COUNT !== VERIFIED_VOICE_SNAPSHOT.verifiedVoices ||
  STATIC_VOICE_MODELS_BY_LOCALE.size !== VERIFIED_VOICE_SNAPSHOT.locales ||
  Object.keys(VERIFIED_VOICES_BY_LANGUAGE).length !== VERIFIED_VOICE_SNAPSHOT.languageFamilies
) {
  throw new Error(
    `[Voice Catalog] Static snapshot integrity mismatch: ` +
    `${STATIC_VERIFIED_VOICE_COUNT} voices / ${STATIC_VOICE_MODELS_BY_LOCALE.size} locales / ` +
    `${Object.keys(VERIFIED_VOICES_BY_LANGUAGE).length} languages.`
  );
}

// If a statically verified voice later fails during real playback, keep it out
// of the effective pool for the remainder of this process. This is NOT a
// verification system and makes no extra Edge request; it only reacts to a
// failure that already happened during normal TTS.
const runtimeUnavailableVoices = new Set();

function isRuntimeUnavailableVoice(voice) {
  return Boolean(voice && runtimeUnavailableVoices.has(voice));
}

function markVoiceUnhealthy(voice) {
  if (!voice || runtimeUnavailableVoices.has(voice)) return;
  runtimeUnavailableVoices.add(voice);
  console.warn(`[Voice Catalog] ${voice} failed during real playback and is disabled until the next restart.`);
}

function getStaticLanguageCatalog(languageKey) {
  return VERIFIED_VOICES_BY_LANGUAGE[languageKey] || null;
}

function getVerifiedVoiceModelsForLocale(locale) {
  return getVoiceModelsForLocale(locale);
}


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

// Persistent Auto-Join uses the same Supabase project as the Staff Platform,
// but stays completely inside index.js so the tested production staffPlatform.js
// and voice-session reconciliation do not need to change.
const AUTO_JOIN_SUPABASE_URL = process.env.SUPABASE_URL;
const AUTO_JOIN_SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const autoJoinSupabase =
  AUTO_JOIN_SUPABASE_URL && AUTO_JOIN_SUPABASE_KEY
    ? createClient(AUTO_JOIN_SUPABASE_URL, AUTO_JOIN_SUPABASE_KEY, {
        auth: { persistSession: false },
      })
    : null;

const autoJoinConfigs = new Map();
let autoJoinSchemaWarningShown = false;

async function refreshPersistentAutoJoinConfigs() {
  autoJoinConfigs.clear();
  if (!autoJoinSupabase || !client?.isReady?.()) return;

  const { data, error } = await autoJoinSupabase
    .from("bozos_bot_guilds")
    .select("guild_id,autojoin_enabled,autojoin_channel_id")
    .eq("bot_key", "tts")
    .eq("active", true);

  if (error) {
    if (!autoJoinSchemaWarningShown) {
      autoJoinSchemaWarningShown = true;
      console.warn(
        "[Auto-Join] Could not load persistent config. Make sure autojoin_enabled and autojoin_channel_id exist in bozos_bot_guilds:",
        error?.message || error
      );
    }
    return;
  }

  for (const row of data || []) {
    const guildId = String(row.guild_id);
    if (!client.guilds.cache.has(guildId)) continue;
    if (!row.autojoin_enabled || !row.autojoin_channel_id) continue;
    autoJoinConfigs.set(guildId, {
      enabled: true,
      channelId: String(row.autojoin_channel_id),
    });
  }
}

function getPersistentAutoJoinConfig(guildId) {
  return autoJoinConfigs.get(String(guildId)) || { enabled: false, channelId: null };
}

async function setPersistentAutoJoinConfig(guild, enabled, channelId = null) {
  if (!autoJoinSupabase) {
    throw new Error("Persistent Auto-Join requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  const { data, error } = await autoJoinSupabase
    .from("bozos_bot_guilds")
    .update({
      autojoin_enabled: Boolean(enabled),
      autojoin_channel_id: enabled ? String(channelId) : null,
      last_seen_at: new Date().toISOString(),
    })
    .eq("bot_key", "tts")
    .eq("guild_id", String(guild.id))
    .select("guild_id")
    .maybeSingle();

  if (error) {
    throw new Error(
      "Could not save Auto-Join. Make sure autojoin_enabled and autojoin_channel_id exist in bozos_bot_guilds."
    );
  }
  if (!data) {
    throw new Error("This server is not present in bozos_bot_guilds yet. Try again in a few seconds.");
  }

  if (enabled) {
    autoJoinConfigs.set(String(guild.id), { enabled: true, channelId: String(channelId) });
  } else {
    autoJoinConfigs.delete(String(guild.id));
  }
}

// /join activation gate. The support guild ID is resolved once from the existing
// support invite, so no extra Railway variable is required. SUPPORT_GUILD_ID can
// still be supplied explicitly as an optional fallback/override.
let supportGuildId = process.env.SUPPORT_GUILD_ID || null;
let supportGuildResolvePromise = null;

function getSupportInviteCode() {
  try {
    const url = new URL(SUPPORT_SERVER_URL);
    return url.pathname.split("/").filter(Boolean).pop() || null;
  } catch {
    return String(SUPPORT_SERVER_URL || "").split("/").filter(Boolean).pop() || null;
  }
}

async function resolveSupportGuild() {
  if (supportGuildId) {
    return client.guilds.cache.get(supportGuildId) ||
      await client.guilds.fetch(supportGuildId).catch(() => null);
  }

  if (!supportGuildResolvePromise) {
    supportGuildResolvePromise = (async () => {
      const inviteCode = getSupportInviteCode();
      if (!inviteCode) return null;

      const invite = await client.fetchInvite(inviteCode);
      supportGuildId = invite?.guild?.id || null;
      if (!supportGuildId) return null;

      return client.guilds.cache.get(supportGuildId) ||
        await client.guilds.fetch(supportGuildId).catch(() => null);
    })()
      .catch((error) => {
        console.warn("[Support Gate] Could not resolve the support server:", error?.message || error);
        return null;
      })
      .finally(() => {
        supportGuildResolvePromise = null;
      });
  }

  return supportGuildResolvePromise;
}

async function getSupportMembershipStatus(userId) {
  const supportGuild = await resolveSupportGuild();
  if (!supportGuild) return "unavailable";

  try {
    // Force a direct REST lookup so a user who leaves the support server is not
    // accepted from a stale member cache. Fetching one known member does not
    // require enabling the privileged GuildMembers gateway intent.
    await supportGuild.members.fetch({ user: userId, force: true });
    return "member";
  } catch (error) {
    if (error?.code === 10007 || error?.status === 404) {
      return "not_member";
    }

    console.warn(
      `[Support Gate] Membership lookup failed for ${userId}:`,
      error?.message || error
    );
    return "unavailable";
  }
}

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
  chinese: { label: "Chinese", voice: "zh-CN-XiaoxiaoNeural", lang: "zh-CN", prefix: (name) => `${name} 说...` },
  japanese: { label: "Japanese", voice: "ja-JP-NanamiNeural", lang: "ja-JP", prefix: (name) => `${name} が言いました...` },
  arabic: { label: "Arabic", voice: "ar-SA-ZariyahNeural", lang: "ar-SA", prefix: (name) => `قال ${name}...` },
  russian: { label: "Russian", voice: "ru-RU-SvetlanaNeural", lang: "ru-RU", prefix: (name) => `${name} сказал...` },
  portuguese: { label: "Portuguese", voice: "pt-BR-FranciscaNeural", lang: "pt-BR", prefix: (name) => `${name} disse...` },
  italian: { label: "Italian", voice: "it-IT-ElsaNeural", lang: "it-IT", prefix: (name) => `${name} ha detto...` },
  korean: { label: "Korean", voice: "ko-KR-SunHiNeural", lang: "ko-KR", prefix: (name) => `${name}님이 말씀하셨습니다...` },
  bengali: { label: "Bengali", voice: "bn-IN-TanishaaNeural", lang: "bn-IN", prefix: (name) => `${name} বলেছেন...` },
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
  azerbaijani: { label: "Azerbaijani", voice: "az-AZ-BanuNeural", lang: "az-AZ", prefix: (name) => `${name}:` },
  bosnian: { label: "Bosnian", voice: "bs-BA-VesnaNeural", lang: "bs-BA", prefix: (name) => `${name}:` },
  galician: { label: "Galician", voice: "gl-ES-SabelaNeural", lang: "gl-ES", prefix: (name) => `${name}:` },
  icelandic: { label: "Icelandic", voice: "is-IS-GudrunNeural", lang: "is-IS", prefix: (name) => `${name}:` },
  inuktitut: { label: "Inuktitut", voice: "iu-Cans-CA-SiqiniqNeural", lang: "iu-Cans-CA", prefix: (name) => `${name}:` },
  javanese: { label: "Javanese", voice: "jv-ID-SitiNeural", lang: "jv-ID", prefix: (name) => `${name}:` },
  georgian: { label: "Georgian", voice: "ka-GE-EkaNeural", lang: "ka-GE", prefix: (name) => `${name}:` },
  kazakh: { label: "Kazakh", voice: "kk-KZ-AigulNeural", lang: "kk-KZ", prefix: (name) => `${name}:` },
  khmer: { label: "Khmer", voice: "km-KH-SreymomNeural", lang: "km-KH", prefix: (name) => `${name}:` },
  lao: { label: "Lao", voice: "lo-LA-KeomanyNeural", lang: "lo-LA", prefix: (name) => `${name}:` },
  macedonian: { label: "Macedonian", voice: "mk-MK-MarijaNeural", lang: "mk-MK", prefix: (name) => `${name}:` },
  mongolian: { label: "Mongolian", voice: "mn-MN-YesuiNeural", lang: "mn-MN", prefix: (name) => `${name}:` },
  maltese: { label: "Maltese", voice: "mt-MT-GraceNeural", lang: "mt-MT", prefix: (name) => `${name}:` },
  burmese: { label: "Burmese", voice: "my-MM-NilarNeural", lang: "my-MM", prefix: (name) => `${name}:` },
  nepali: { label: "Nepali", voice: "ne-NP-HemkalaNeural", lang: "ne-NP", prefix: (name) => `${name}:` },
  pashto: { label: "Pashto", voice: "ps-AF-LatifaNeural", lang: "ps-AF", prefix: (name) => `${name}:` },
  sinhala: { label: "Sinhala", voice: "si-LK-ThiliniNeural", lang: "si-LK", prefix: (name) => `${name}:` },
  somali: { label: "Somali", voice: "so-SO-UbaxNeural", lang: "so-SO", prefix: (name) => `${name}:` },
  albanian: { label: "Albanian", voice: "sq-AL-AnilaNeural", lang: "sq-AL", prefix: (name) => `${name}:` },
  sundanese: { label: "Sundanese", voice: "su-ID-TutiNeural", lang: "su-ID", prefix: (name) => `${name}:` },
  uzbek: { label: "Uzbek", voice: "uz-UZ-MadinaNeural", lang: "uz-UZ", prefix: (name) => `${name}:` },
  zulu: { label: "Zulu", voice: "zu-ZA-ThandoNeural", lang: "zu-ZA", prefix: (name) => `U-${name} uthe...` },
};

const STATIC_LANGUAGE_CONFIG_KEYS = Object.keys(VERIFIED_VOICES_BY_LANGUAGE);
const missingLanguageConfigs = STATIC_LANGUAGE_CONFIG_KEYS.filter((key) => !LANGUAGE_CONFIGS[key]);
const nonVerifiedLanguageConfigs = Object.keys(LANGUAGE_CONFIGS).filter((key) => !VERIFIED_VOICES_BY_LANGUAGE[key]);

if (missingLanguageConfigs.length || nonVerifiedLanguageConfigs.length) {
  throw new Error(
    `[Voice Catalog] Language categorization mismatch. Missing configs: ` +
    `${missingLanguageConfigs.join(", ") || "none"}; unsupported configs: ` +
    `${nonVerifiedLanguageConfigs.join(", ") || "none"}.`
  );
}

// In-memory per-guild settings. Settings reset when the bot process restarts.
// This intentionally avoids filesystem/database persistence so the repo stays self-contained.
const guildSettingsCache = new Map();

const DEFAULT_GUILD_SETTINGS = {
  serverLanguage: "english",
  serverAccent: "en-us",
  volume: 1,
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
  serverVoice: null,
  userVoices: {},
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
  const selection = getGuildLanguageSelection(guildId, userId);
  const config = LANGUAGE_CONFIGS[selection.language] || LANGUAGE_CONFIGS.english;

  // Keep the language-level prefix/metadata, but use the exact selected
  // locale for number/date normalization and sentence segmentation.
  return {
    ...config,
    lang: getSelectionLocale(selection),
  };
}

function getDefaultAccent(languageKey) {
  const catalog = getStaticLanguageCatalog(languageKey);
  const config = LANGUAGE_CONFIGS[languageKey] || LANGUAGE_CONFIGS.english;
  return String(catalog?.defaultLocale || config.lang || "en-US").toLowerCase();
}

function localeRegion(locale) {
  const parts = String(locale || "").split("-");
  const region = parts.find((part, index) => index > 0 && /^[A-Za-z]{2}$/.test(part));
  return region?.toLowerCase() || parts[1]?.toLowerCase() || "default";
}

function formatLocaleVariant(locale) {
  const parts = String(locale || "").split("-").slice(1);
  if (!parts.length) return String(locale || "").toUpperCase();

  return parts
    .map((part) => {
      if (/^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" · ");
}

function getPreferredVoiceForLocale(locale) {
  const all = STATIC_VOICE_MODELS_BY_LOCALE.get(locale) || [];
  if (!all.length) return null;
  return all.find((entry) => entry.gender === "Female")?.voice || all[0].voice;
}

function getAccentEntries(languageKey) {
  const catalog = getStaticLanguageCatalog(languageKey);
  if (!catalog) return [];

  const defaultLocale = catalog.defaultLocale;
  return Object.keys(catalog.locales || {})
    .sort((a, b) => {
      if (a === defaultLocale) return -1;
      if (b === defaultLocale) return 1;
      return a.localeCompare(b);
    })
    .map((locale) => ({
      key: locale.toLowerCase(),
      locale,
      voice:
        locale === defaultLocale && catalog.defaultVoice
          ? catalog.defaultVoice
          : getPreferredVoiceForLocale(locale),
      voiceCount: (catalog.locales?.[locale] || []).length,
    }));
}

function getLocaleForAccent(languageKey, accent = "default") {
  const catalog = getStaticLanguageCatalog(languageKey);
  const config = LANGUAGE_CONFIGS[languageKey] || LANGUAGE_CONFIGS.english;
  if (!catalog) return config.lang || "en-US";

  const locales = Object.keys(catalog.locales || {});
  if (!locales.length) return config.lang || "en-US";

  const requested = String(accent || "").toLowerCase();
  if (!requested || requested === "default") return catalog.defaultLocale || locales[0];

  // New static-catalog settings store the complete locale as the accent key.
  const exact = locales.find((locale) => locale.toLowerCase() === requested);
  if (exact) return exact;

  // Accept old in-memory region-only values such as "us", "uk", "br", etc.
  // This matters only during hot code reloads; normal deploys reset the Map.
  const defaultLocale = catalog.defaultLocale || locales[0];
  if (localeRegion(defaultLocale) === requested) return defaultLocale;

  const regional = locales.find((locale) => localeRegion(locale) === requested);
  return regional || defaultLocale;
}

function getVoiceForLanguage(languageKey, accent = "default") {
  const catalog = getStaticLanguageCatalog(languageKey);
  const config = LANGUAGE_CONFIGS[languageKey] || LANGUAGE_CONFIGS.english;
  const locale = getLocaleForAccent(languageKey, accent);

  if (catalog?.defaultLocale === locale && catalog.defaultVoice) {
    const defaultStillAvailable = getVoiceModelsForLocale(locale)
      .some((entry) => entry.voice === catalog.defaultVoice);
    if (defaultStillAvailable) return catalog.defaultVoice;
  }

  const available = getVoiceModelsForLocale(locale);
  return available.find((entry) => entry.gender === "Female")?.voice
    || available[0]?.voice
    || getPreferredVoiceForLocale(locale)
    || config.voice;
}

function getEffectiveAccent(guildId, userId = null) {
  return getGuildLanguageSelection(guildId, userId).accent;
}

function getLanguageVariantLabel(languageKey, accent) {
  const config = LANGUAGE_CONFIGS[languageKey] || LANGUAGE_CONFIGS.english;
  const locale = getLocaleForAccent(languageKey, accent);
  return `${config.label} (${formatLocaleVariant(locale)})`;
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
        locale: entry.locale,
        voiceCount: entry.voiceCount,
        label: getLanguageVariantLabel(languageKey, entry.key),
        config,
      });
    }
  }

  return variants.sort(
    (a, b) =>
      a.config.label.localeCompare(b.config.label) ||
      a.locale.localeCompare(b.locale)
  );
}

function getVoiceLocale(voice) {
  if (STATIC_LOCALE_BY_VOICE.has(voice)) return STATIC_LOCALE_BY_VOICE.get(voice);
  return String(voice || "").split("-").slice(0, 2).join("-");
}

function getSelectionLocale(selection) {
  return getLocaleForAccent(selection.language, selection.accent);
}

function getVoiceModelsForLocale(locale) {
  return (STATIC_VOICE_MODELS_BY_LOCALE.get(locale) || [])
    .filter((entry) => !isRuntimeUnavailableVoice(entry.voice));
}

function isListedEdgeVoice(voice) {
  if (!voice || isRuntimeUnavailableVoice(voice)) return false;
  const locale = getVoiceLocale(voice);
  return getVoiceModelsForLocale(locale).some((entry) => entry.voice === voice);
}

function getVoicePersonaName(voice) {
  const locale = getVoiceLocale(voice);
  const raw = String(voice || "").startsWith(`${locale}-`)
    ? String(voice).slice(locale.length + 1)
    : String(voice || "").split("-").slice(2).join("-") || voice || "Default";

  return raw
    .replace(/IndicNeural$/i, " Indic")
    .replace(/MultilingualNeural$/i, " Multilingual")
    .replace(/Neural$/i, "")
    .trim();
}

function getVoiceModelInfo(voice) {
  const locale = getVoiceLocale(voice);
  const model = getVoiceModelsForLocale(locale).find((entry) => entry.voice === voice)
    || STATIC_VOICE_MODELS_BY_LOCALE.get(locale)?.find((entry) => entry.voice === voice);

  return {
    voice,
    locale,
    languageKey: model?.languageKey || STATIC_LANGUAGE_KEY_BY_LOCALE.get(locale) || null,
    name: getVoicePersonaName(voice),
    gender: model?.gender || "Neural",
  };
}

function isVoiceCompatibleWithSelection(voice, selection) {
  return (
    Boolean(voice) &&
    getVoiceLocale(voice) === getSelectionLocale(selection) &&
    isListedEdgeVoice(voice)
  );
}

function getEffectiveVoice(guildId, userId = null) {
  const settings = getGuildSettings(guildId);
  const selection = getGuildLanguageSelection(guildId, userId);

  if (userId) {
    const personalVoice = settings.userVoices?.[userId];
    if (isVoiceCompatibleWithSelection(personalVoice, selection)) {
      return personalVoice;
    }
  }

  if (isVoiceCompatibleWithSelection(settings.serverVoice, selection)) {
    return settings.serverVoice;
  }

  const defaultVoice = getVoiceForLanguage(selection.language, selection.accent);
  if (isListedEdgeVoice(defaultVoice)) return defaultVoice;

  return getVoiceModelsForLocale(getSelectionLocale(selection))[0]?.voice || defaultVoice;
}

function getEffectiveVoiceSettings(guildId, userId = null) {
  const settings = getGuildSettings(guildId);
  return {
    rate: TTS_VOICE_SETTINGS.rate,
    pitch: TTS_VOICE_SETTINGS.pitch,
    volume: TTS_VOICE_SETTINGS.volume,
    outputFormat: TTS_VOICE_SETTINGS.outputFormat,
    saveSubtitles: TTS_VOICE_SETTINGS.saveSubtitles,
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


/* =========================================================
   GRAND HUMAN-LIKE PRONUNCIATION ENGINE
   Built-in only: no user/server editing commands.
========================================================= */

const PRONUNCIATION_ENGINE_VERSION = "2026.08.25-v2";

function spellLetters(value) {
  return String(value || "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
    .split("")
    .join(" ");
}

// Research-backed or widely standardized pronunciations for terms that
// generic TTS engines often read unnaturally. Ambiguous terms such as SQL/GIF
// deliberately use conservative, unambiguous readings where possible.
const GRAND_CANONICAL_PRONUNCIATIONS = [
  { phrase: "PostgreSQL", spoken: "Post Gres Q L" },
  { phrase: "Postgres", spoken: "Post Gres" },
  { phrase: "MySQL", spoken: "My S Q L" },
  { phrase: "SQLite", spoken: "S Q lite" },
  { phrase: "NoSQL", spoken: "No S Q L" },
  { phrase: "GraphQL", spoken: "Graph Q L" },
  { phrase: "JSON", spoken: "Jason" },
  { phrase: "YAML", spoken: "yam ul" },
  { phrase: "NGINX", spoken: "engine X" },
  { phrase: "nginx", spoken: "engine X", caseSensitive: true },
  { phrase: "GNU/Linux", spoken: "guh new slash Linux" },
  { phrase: "GNU", spoken: "guh new" },
  { phrase: "Debian", spoken: "Deb ee en" },
  { phrase: "Ubuntu", spoken: "oo boon too" },
  { phrase: "Kubernetes", spoken: "koo ber net eez" },
  { phrase: "kubectl", spoken: "kube control" },
  { phrase: "K8s", spoken: "K eight S" },
  { phrase: "Redis", spoken: "red iss" },
  { phrase: "Linux", spoken: "lih nucks" },
  { phrase: "cache", spoken: "cash", englishOnly: true },
  { phrase: "daemon", spoken: "dee mon", englishOnly: true },
  { phrase: "ASCII", spoken: "ass key" },
  { phrase: "GUI", spoken: "gooey" },
  { phrase: "BIOS", spoken: "bye oss" },
  { phrase: "OAuth", spoken: "oh auth" },
  { phrase: "WebAssembly", spoken: "Web Assembly" },
  { phrase: "WASM", spoken: "waz em" },
  { phrase: "REST", spoken: "rest", caseSensitive: true },
  { phrase: "CRUD", spoken: "crud", caseSensitive: true },
  { phrase: "SOAP", spoken: "soap", caseSensitive: true },
  { phrase: "AJAX", spoken: "ay jacks", caseSensitive: true },
  { phrase: "REPL", spoken: "rep ul", caseSensitive: true },
  { phrase: "OLED", spoken: "oh led", caseSensitive: true },
  { phrase: "QLED", spoken: "Q led", caseSensitive: true },
  { phrase: "NVMe", spoken: "N V M E" },
  { phrase: "PCIe", spoken: "P C I E" },
  { phrase: "CI/CD", spoken: "C I C D", caseSensitive: true },
  { phrase: "5G", spoken: "five G", caseSensitive: true },
  { phrase: "4G", spoken: "four G", caseSensitive: true },
  { phrase: "3G", spoken: "three G", caseSensitive: true },
  { phrase: "CUDA", spoken: "koo duh" },
  { phrase: "JPEG", spoken: "jay peg" },
  { phrase: "JPG", spoken: "jay peg" },
  { phrase: "MPEG", spoken: "em peg" },
  { phrase: "FFmpeg", spoken: "F F em peg" },
  { phrase: "ffmpeg", spoken: "F F em peg", caseSensitive: true },
  { phrase: "Node.js", spoken: "Node J S" },
  { phrase: "Next.js", spoken: "Next J S" },
  { phrase: "Nuxt.js", spoken: "Nuxt J S" },
  { phrase: "Vue.js", spoken: "View J S" },
  { phrase: "React.js", spoken: "React J S" },
  { phrase: "Three.js", spoken: "Three J S" },
  { phrase: "Express.js", spoken: "Express J S" },
  { phrase: "Discord.js", spoken: "Discord J S" },
  { phrase: "OpenAI", spoken: "Open A I" },
  { phrase: "ChatGPT", spoken: "Chat G P T" },
  { phrase: "GitHub", spoken: "Git Hub" },
  { phrase: "GitLab", spoken: "Git Lab" },
  { phrase: "PyPI", spoken: "pie P I" },
  { phrase: "NumPy", spoken: "num pie" },
  { phrase: "SciPy", spoken: "sigh pie" },
  { phrase: "PyTorch", spoken: "pie torch" },
  { phrase: "C++", spoken: "C plus plus" },
  { phrase: "C#", spoken: "C sharp" },
  { phrase: "F#", spoken: "F sharp" },
  { phrase: ".NET", spoken: "dot net" },
  { phrase: "macOS", spoken: "Mac O S" },
  { phrase: "iOS", spoken: "eye O S" },
  { phrase: "iPadOS", spoken: "eye pad O S" },
  { phrase: "watchOS", spoken: "watch O S" },
  { phrase: "tvOS", spoken: "T V O S" },
  { phrase: "Wi-Fi", spoken: "why fie" },
  { phrase: "WiFi", spoken: "why fie" },
  { phrase: "GTA V", spoken: "G T A five" },
  { phrase: "GTA 5", spoken: "G T A five" },
  { phrase: "RDR2", spoken: "R D R two" },
  { phrase: "CS:GO", spoken: "C S go" },
  { phrase: "CS2", spoken: "C S two" },
  { phrase: "PUBG", spoken: "P U B G" },
  { phrase: "LoL", spoken: "League of Legends", caseSensitive: true },
  { phrase: "WoW", spoken: "World of Warcraft", caseSensitive: true },
  { phrase: "PS5", spoken: "P S five" },
  { phrase: "PS4", spoken: "P S four" },
  { phrase: "2FA", spoken: "two factor authentication" },
  { phrase: "MFA", spoken: "multi factor authentication" },
  { phrase: "top.gg", spoken: "top dot G G" },
  { phrase: "Top.gg", spoken: "top dot G G", caseSensitive: true },
].sort((a, b) => b.phrase.length - a.phrase.length);

// Common acronyms users often type in lowercase. These are intentionally
// restricted to terms that are unlikely to be ordinary words.
const COMMON_CASE_INSENSITIVE_INITIALISMS = new Set([
  "tts", "stt", "asr", "vc", "dm", "dms", "afk", "ai", "api", "sdk",
  "cpu", "gpu", "tpu", "vram", "fps", "url", "uri", "http", "https",
  "html", "css", "js", "jsx", "ts", "tsx", "xml", "sql", "php", "npm",
  "npx", "pnpm", "npc", "rpg", "arpg", "mmorpg", "mmo", "pvp", "pve",
  "dps", "rng", "aoe", "hud", "mmr", "kda", "smp", "rts", "moba",
  "ssh", "ssl", "tls", "vpn", "cdn", "dns", "dhcp", "tcp", "udp",
  "jwt", "csrf", "xss", "llm", "vlm", "nlp", "nlu", "rag", "agi",
  "rlhf", "sft", "pdf", "png", "svg", "csv", "faq", "fyi", "gg", "wp",
  "yt", "ttv", "nsfw", "sfw", "otp", "uuid", "uid", "db", "qa",
]);

const CHAT_EXPANSION_RULES = [
  { phrase: "brb", spoken: "be right back" },
  { phrase: "btw", spoken: "by the way" },
  { phrase: "idk", spoken: "I don't know" },
  { phrase: "imo", spoken: "in my opinion" },
  { phrase: "imho", spoken: "in my humble opinion" },
  { phrase: "irl", spoken: "in real life" },
  { phrase: "tbh", spoken: "to be honest" },
  { phrase: "ngl", spoken: "not gonna lie" },
  { phrase: "omw", spoken: "on my way" },
  { phrase: "ikr", spoken: "I know, right" },
  { phrase: "afaik", spoken: "as far as I know" },
  { phrase: "iirc", spoken: "if I remember correctly" },
  { phrase: "fwiw", spoken: "for what it's worth" },
  { phrase: "tldr", spoken: "too long, didn't read" },
  { phrase: "nvm", spoken: "never mind" },
  { phrase: "lmk", spoken: "let me know" },
  { phrase: "hmu", spoken: "hit me up" },
  { phrase: "ttyl", spoken: "talk to you later" },
  { phrase: "gtg", spoken: "got to go" },
  { phrase: "g2g", spoken: "got to go" },
  { phrase: "glhf", spoken: "good luck, have fun" },
  { phrase: "ggwp", spoken: "good game, well played" },
  { phrase: "tysm", spoken: "thank you so much" },
  { phrase: "wdym", spoken: "what do you mean" },
  { phrase: "wym", spoken: "what do you mean" },
  { phrase: "idc", spoken: "I don't care" },
  { phrase: "wbu", spoken: "what about you" },
  { phrase: "hbu", spoken: "how about you" },
  { phrase: "wyd", spoken: "what are you doing" },
  { phrase: "wya", spoken: "where are you" },
  { phrase: "icymi", spoken: "in case you missed it" },
  { phrase: "asap", spoken: "as soon as possible" },
  { phrase: "smh", spoken: "shaking my head" },
  { phrase: "omg", spoken: "oh my God" },
  { phrase: "lmao", spoken: "L M A O" },
  { phrase: "rofl", spoken: "R O F L" },
  { phrase: "wtf", spoken: "W T F" },
  { phrase: "stfu", spoken: "S T F U" },
].map((entry) => ({ ...entry, caseSensitive: false }))
  .sort((a, b) => b.phrase.length - a.phrase.length);

// Short chat forms are case-sensitive to avoid corrupting real names/words:
// e.g. "Ty" can be a person's name while lowercase "ty" commonly means thank you.
const EXACT_CHAT_RULES = [
  { phrase: "rn", spoken: "right now" },
  { phrase: "ty", spoken: "thank you" },
  { phrase: "yw", spoken: "you're welcome" },
  { phrase: "np", spoken: "no problem" },
  { phrase: "pls", spoken: "please" },
  { phrase: "plz", spoken: "please" },
  { phrase: "sry", spoken: "sorry" },
  { phrase: "msg", spoken: "message" },
  { phrase: "ppl", spoken: "people" },
  { phrase: "tmr", spoken: "tomorrow" },
  { phrase: "tmrw", spoken: "tomorrow" },
  { phrase: "bday", spoken: "birthday" },
  { phrase: "bc", spoken: "because" },
  { phrase: "bcz", spoken: "because" },
  { phrase: "cuz", spoken: "because" },
  { phrase: "coz", spoken: "because" },
  { phrase: "abt", spoken: "about" },
  { phrase: "ur", spoken: "your" },
  { phrase: "u", spoken: "you" },
  { phrase: "r", spoken: "are" },
  { phrase: "atm", spoken: "at the moment" },
  { phrase: "mb", spoken: "my bad" },
  { phrase: "ez", spoken: "easy" },
  { phrase: "im", spoken: "I'm" },
  { phrase: "ive", spoken: "I've" },
  { phrase: "ill", spoken: "I'll" },
  { phrase: "dont", spoken: "don't" },
  { phrase: "cant", spoken: "can't" },
  { phrase: "wont", spoken: "won't" },
  { phrase: "didnt", spoken: "didn't" },
  { phrase: "doesnt", spoken: "doesn't" },
  { phrase: "isnt", spoken: "isn't" },
  { phrase: "arent", spoken: "aren't" },
  { phrase: "wasnt", spoken: "wasn't" },
  { phrase: "werent", spoken: "weren't" },
  { phrase: "shouldnt", spoken: "shouldn't" },
  { phrase: "wouldnt", spoken: "wouldn't" },
  { phrase: "couldnt", spoken: "couldn't" },
  { phrase: "havent", spoken: "haven't" },
  { phrase: "hasnt", spoken: "hasn't" },
  { phrase: "hadnt", spoken: "hadn't" },
  { phrase: "youre", spoken: "you're" },
  { phrase: "theyre", spoken: "they're" },
  { phrase: "weve", spoken: "we've" },
  { phrase: "youve", spoken: "you've" },
  { phrase: "thats", spoken: "that's" },
  { phrase: "whats", spoken: "what's" },
  { phrase: "lets", spoken: "let's" },
].map((entry) => ({ ...entry, caseSensitive: true }))
  .sort((a, b) => b.phrase.length - a.phrase.length);

const FILE_EXTENSION_SPEECH = new Map([
  ["js", "J S"], ["jsx", "J S X"], ["ts", "T S"], ["tsx", "T S X"],
  ["json", "Jason"], ["yaml", "yam ul"], ["yml", "Y M L"], ["xml", "X M L"],
  ["html", "H T M L"], ["css", "C S S"], ["env", "E N V"], ["exe", "E X E"],
  ["pdf", "P D F"], ["png", "P N G"], ["jpg", "jay peg"], ["jpeg", "jay peg"],
  ["gif", "gif"], ["svg", "S V G"], ["csv", "C S V"], ["txt", "T X T"],
  ["md", "M D"], ["zip", "zip"], ["rar", "R A R"], ["7z", "seven zip"],
  ["mp3", "M P three"], ["mp4", "M P four"], ["wav", "wave"], ["flac", "flack"],
  ["webm", "web em"], ["mkv", "M K V"], ["avi", "A V I"], ["mov", "M O V"],
]);

const COMMON_CASE_SENSITIVE_INITIALISMS = new Set([
  // Ambiguous as lowercase words, so only spell them when the author wrote caps.
  "OS", "PC", "UI", "UX", "IP", "ID", "ML", "VR", "AR", "IT", "TV", "DJ",
  "SSD", "HDD", "USB", "HDMI", "PSU", "DDR", "RGB", "LED", "LCD", "NFC", "GPS",
  "LTE", "SIM", "QR", "SMS", "MMS", "VPS", "VM", "AWS", "GCP", "OCI", "S3",
  "EC2", "CI", "CD", "QA", "SRE", "DBA", "CEO", "CTO", "CFO", "COO", "HR",
  "USA", "UK", "UAE", "EU", "UN", "WHO", "FBI", "CIA", "BBC", "CNN",
  "JEE", "CBSE", "ICSE", "IIT", "NIT", "GPA", "CGPA", "SAT", "FAQ",
  "EDM", "BPM", "KDR", "KD", "HP", "XP", "TPS", "RTS", "SMP",
]);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceLiteralPhrase(text, phrase, replacement, caseSensitive = false) {
  if (!phrase) return text;
  const escaped = escapeRegex(phrase);
  const startsWord = /^[\p{L}\p{N}_]/u.test(phrase);
  const endsWord = /[\p{L}\p{N}_]$/u.test(phrase);
  const pattern = `${startsWord ? "(?<![\\p{L}\\p{N}_])" : ""}${escaped}${endsWord ? "(?![\\p{L}\\p{N}_])" : ""}`;
  return text.replace(new RegExp(pattern, caseSensitive ? "gu" : "giu"), replacement);
}

function applyRuleList(text, rules, languageKey = "english") {
  let output = text;
  for (const rule of rules) {
    if (rule.englishOnly && languageKey !== "english") continue;
    output = replaceLiteralPhrase(output, rule.phrase, rule.spoken, Boolean(rule.caseSensitive));
  }
  return output;
}

function pluralizeUnit(value, singular, plural = `${singular}s`) {
  return Number(value) === 1 ? singular : plural;
}

function applyContextualPronunciations(text) {
  let output = text;

  // Version strings: v3.1.2 -> version 3 point 1 point 2.
  output = output.replace(/\bv(\d+(?:\.\d+){1,4})\b/gi, (_, version) =>
    `version ${version.split(".").join(" point ")}`
  );

  // IP addresses: read dotted quads as groups instead of one giant decimal.
  output = output.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    (_, a, b, c, d) => `${a} dot ${b} dot ${c} dot ${d}`
  );

  // Extremely long Discord/user/service IDs are clearer digit-by-digit.
  output = output.replace(/\b\d{15,22}\b/g, (digits) => digits.split("").join(" "));

  // Storage sizes and memory capacities.
  output = output.replace(/\b(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)\b/g, (_, value, unit) => {
    const names = {
      KB: ["kilobyte", "kilobytes"], MB: ["megabyte", "megabytes"],
      GB: ["gigabyte", "gigabytes"], TB: ["terabyte", "terabytes"],
    };
    const [singular, plural] = names[unit];
    return `${value} ${pluralizeUnit(value, singular, plural)}`;
  });
  output = output.replace(/\b(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|TiB)\b/g, (_, value, unit) => {
    const names = {
      KiB: ["kibibyte", "kibibytes"], MiB: ["mebibyte", "mebibytes"],
      GiB: ["gibibyte", "gibibytes"], TiB: ["tebibyte", "tebibytes"],
    };
    const [singular, plural] = names[unit];
    return `${value} ${pluralizeUnit(value, singular, plural)}`;
  });

  // Network rates and clock frequencies.
  output = output.replace(/\b(\d+(?:\.\d+)?)\s*(Kbps|Mbps|Gbps|Tbps)\b/g, (_, value, unit) => {
    const names = { Kbps: "kilobits", Mbps: "megabits", Gbps: "gigabits", Tbps: "terabits" };
    return `${value} ${names[unit]} per second`;
  });
  output = output.replace(/\b(\d+(?:\.\d+)?)\s*(kHz|MHz|GHz)\b/g, (_, value, unit) => {
    const names = { kHz: "kilohertz", MHz: "megahertz", GHz: "gigahertz" };
    return `${value} ${names[unit]}`;
  });
  output = output.replace(/\b(\d+(?:\.\d+)?)\s*FPS\b/g, "$1 F P S");
  output = output.replace(/\b(\d+)p\b/g, "$1 P");

  // Common hardware/model forms.
  output = output.replace(/\b(RTX|GTX|DDR|USB|HDMI)(\d{1,5})\b/g, (_, prefix, number) =>
    `${spellLetters(prefix)} ${number}`
  );
  output = output.replace(/\bGPT[- ]?(\d+(?:\.\d+)?)\b/gi, (_, number) => `G P T ${number}`);
  output = output.replace(/\bV(\d+(?:\.\d+)?)\b/g, (_, number) => `V ${number}`);
  output = output.replace(/\bIPv([46])\b/g, (_, version) => `I P V ${version}`);

  // Filename extensions after proper-name rules have already run.
  output = output.replace(/\.([A-Za-z0-9]{1,5})\b/g, (whole, ext) => {
    const spoken = FILE_EXTENSION_SPEECH.get(ext.toLowerCase());
    return spoken ? ` dot ${spoken}` : whole;
  });

  return output;
}

function applyCommonInitialisms(text) {
  let output = text;

  for (const token of COMMON_CASE_INSENSITIVE_INITIALISMS) {
    const spoken = token === "yt" ? "YouTube" : spellLetters(token);
    output = replaceLiteralPhrase(output, token, spoken, false);
  }

  for (const token of COMMON_CASE_SENSITIVE_INITIALISMS) {
    output = replaceLiteralPhrase(output, token, spellLetters(token), true);
  }

  // Plural forms of known initialisms: APIs -> A P I's, GPUs -> G P U's.
  const known = new Set([
    ...[...COMMON_CASE_INSENSITIVE_INITIALISMS].map((item) => item.toUpperCase()),
    ...COMMON_CASE_SENSITIVE_INITIALISMS,
  ]);
  output = output.replace(/\b([A-Z]{2,6})s\b/g, (whole, acronym) =>
    known.has(acronym) ? `${spellLetters(acronym)}'s` : whole
  );

  return output;
}

function normalizeExpressiveSpelling(text) {
  return String(text || "")
    // Keep a hint of emphasis without letting a held key become a multi-second drone.
    .replace(/([\p{L}])\1{3,}/giu, "$1$1")
    .replace(/([!?])\1{2,}/g, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeConversationalExpressions(text, languageKey = "english") {
  let output = String(text || "");

  // Unicode-styled Discord text (𝓗𝓮𝓵𝓵𝓸, full-width text, etc.) becomes normal
  // readable characters before the pronunciation rules run.
  output = output.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');

  // Common text laughter should sound like laughter rather than a long sequence
  // of individual syllables/letters. Keep this language-aware where conventions differ.
  if (languageKey === 'spanish') {
    output = output.replace(/\b(?:ja){3,}j?a?\b/gi, 'jajaja');
  } else if (languageKey === 'portuguese') {
    output = output.replace(/\b(?:k{3,}|(?:rs){2,})\b/gi, 'haha');
  } else if (languageKey === 'japanese') {
    output = output.replace(/(?:ｗ|w){3,}/giu, '笑い');
  } else {
    output = output.replace(/\b(?:ha){3,}h?a?\b/gi, 'haha');
    output = output.replace(/\b(?:he){3,}h?e?\b/gi, 'hehe');
  }

  // Human-friendly emoticons. Emoji glyphs are handled by normalizeEmoji().
  output = output
    .replace(/<3/g, ' heart ')
    .replace(/(?<!\S):-?\)(?!\S)/g, ' smile ')
    .replace(/(?<!\S):-?\((?!\S)/g, ' sad ')
    .replace(/(?<!\S);-?\)(?!\S)/g, ' wink ');

  // Make common English shorthand read naturally without expanding ambiguous
  // ordinary words in other languages.
  if (languageKey === 'english') {
    output = output
      .replace(/\blol+\b/gi, 'laughing')
      .replace(/\bthx\b/gi, 'thanks')
      .replace(/\btho\b/gi, 'though')
      .replace(/\bprob\b/gi, 'probably');
  }

  return output.replace(/\s+/g, ' ').trim();
}

function applyGrandPronunciation(text, { languageKey = "english", mode = "speech" } = {}) {
  let output = normalizeConversationalExpressions(text, languageKey);
  output = normalizeExpressiveSpelling(output);

  // Protect real dotted product/runtime names such as Node.js and .NET before
  // the generic filename-extension reader handles package.json/index.js.
  const dottedCanonicalRules = GRAND_CANONICAL_PRONUNCIATIONS.filter((rule) => rule.phrase.includes("."));
  output = applyRuleList(output, dottedCanonicalRules, languageKey);
  output = applyContextualPronunciations(output);
  output = applyRuleList(output, GRAND_CANONICAL_PRONUNCIATIONS, languageKey);

  if (mode === "speech") {
    output = applyRuleList(output, CHAT_EXPANSION_RULES, languageKey);
    if (languageKey === "english") {
      output = applyRuleList(output, EXACT_CHAT_RULES, languageKey);
    }
  }

  output = applyCommonInitialisms(output);
  return output.replace(/\s+/g, " ").trim();
}

function decodeEmbeddedLeetspeak(token) {
  if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return token;
  const substitutions = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t" };
  return token.replace(/(?<=[A-Za-z])[03457](?=[A-Za-z])/g, (digit) => substitutions[digit] || digit);
}

function humanizeDisplayName(name) {
  let output = String(name || "someone")
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim();

  // Remove common decorative xX...Xx wrappers without touching normal names.
  const hadDecorativeXPrefix = /^[_.\-~|]*[xX]{2}(?=[A-Za-z0-9])/.test(output);
  output = output.replace(/^[_.\-~|]*[xX]{2}(?=[A-Za-z0-9])/, "");
  if (hadDecorativeXPrefix) {
    output = output.replace(/[_.\-~|]*[xX]{2}[_.\-~|]*$/, "");
  } else {
    output = output.replace(/[_.\-~|]+[xX]{2}[_.\-~|]*$/, "");
  }
  output = output
    .replace(/[_.\-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\b[A-Za-z]*\d[A-Za-z]+\b/g, (token) => decodeEmbeddedLeetspeak(token))
    .replace(/([A-Za-z])(\d+)/g, "$1 $2")
    .replace(/(\d+)([A-Za-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  return staffPlatform.isFeatureEnabled("pronunciation")
    ? applyGrandPronunciation(output, { mode: "name" })
    : output;
}

function applyHumanPronunciation(text, guildId = null, userId = null) {
  if (!staffPlatform.isFeatureEnabled("pronunciation")) {
    return String(text ?? "");
  }
  const languageKey = guildId ? getGuildLanguage(guildId, userId) : "english";
  return applyGrandPronunciation(text, { languageKey, mode: "speech" });
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
      "`/auto-join` — Enable or disable persistent Auto-Join for one VC.\n" +
      "`/leave` — Disconnect from the voice channel.\n" +
      "`/language` — Choose a server or personal language + regional accent.\n" +
      "`/voice` — Choose a male or female neural voice for the active language.\n" +
      "`/volume` — Set playback volume from 0–200%.\n" +
      "" +
      "`/skip` — Skip the current TTS message.\n\n" +
      "🗣️ **Grand Pronunciation Engine** — Automatically humanizes chat slang, acronyms, tech/gaming terms, file formats, units, and Discord-style usernames.\n\n" +
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
      return `Bozos TTS supports **${Object.keys(LANGUAGE_CONFIGS).length} languages** across **${variantCount} regional locales**, with **${VERIFIED_VOICE_SNAPSHOT.verifiedVoices} permanently verified neural voices**:\n\n${languages}\n\nUse \`/language\` to choose a language/region, then \`/voice\` to choose a voice!`;
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

  const spokenName = humanizeDisplayName(speakerName, guildId, userId);
  // A colon gives the TTS engine a natural pause without forcing the repetitive
  // "John said..." construction on every message.
  return `${spokenName}: ${cleanedMessage}`;
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

let isShuttingDown = false;

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
    .setName("auto-join")
    .setDescription("Enable or disable persistent Auto-Join for this server")
    .addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription("Enable or disable Auto-Join")
        .setRequired(true)
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
        .setRequired(true)
        .addChoices(
          { name: "Server", value: "server" },
          { name: "Only me", value: "personal" },
        )
    ),

  new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Choose a neural voice for the current language and accent")
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription("Who should this voice apply to?")
        .setRequired(true)
        .addChoices(
          { name: "Server", value: "server" },
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
    currentResource: null,
    processing: false,
    skipRequested: false,
    emptyChannelTimer: null,
    reconnectTimer: null,
    manualDisconnect: false,
    lastQueuedSpeakerId: null,
    lastQueuedSpeakerAt: 0,
    prefetchedJobId: null,
    connectedAt: null,
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
   EDGE TTS — TRUE STREAMING ENGINE
========================================================= */

const playbackLatencySamples = [];

function recordPlaybackLatency(ms) {
  if (!Number.isFinite(ms)) return;
  playbackLatencySamples.push(ms);
  if (playbackLatencySamples.length > LATENCY_SAMPLE_LIMIT) playbackLatencySamples.shift();

  const sorted = [...playbackLatencySamples].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
  client.bozoMetrics = {
    samples: sorted.length,
    playbackLatencyP50Ms: Math.round(percentile(0.50)),
    playbackLatencyP95Ms: Math.round(percentile(0.95)),
    playbackLatencyLastMs: Math.round(ms),
  };
}

function escapeSsmlText(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function createStreamingTts(text, guildId, userId = null, messageReceivedAt = performance.now()) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("TTS text cannot be empty.");

  const languageConfig = getGuildLanguageConfig(guildId, userId);
  const selectedVoice = getEffectiveVoice(guildId, userId);
  const locale = getVoiceLocale(selectedVoice);
  const alternates = getVoiceModelsForLocale(locale)
    .map((entry) => entry.voice)
    .filter((voice) => voice !== selectedVoice);
  const candidates = [selectedVoice, ...alternates].filter(Boolean).slice(0, 3);
  let lastError = null;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const voice = candidates[candidateIndex];
    const edgeTts = createSafeMsEdgeTTS();
    const synthesisStartedAt = performance.now();

    try {
      await edgeTts.setMetadata(voice, TTS_VOICE_SETTINGS.outputFormat);
      const metadataReadyAt = performance.now();
      const result = await Promise.resolve(
        edgeTts.toStream(escapeSsmlText(cleanText), {
          rate: TTS_VOICE_SETTINGS.rate,
          pitch: TTS_VOICE_SETTINGS.pitch,
          volume: TTS_VOICE_SETTINGS.volume,
        })
      );

      const sourceStream = result?.audioStream;
      if (!sourceStream?.pipe) throw new Error("Edge TTS did not return a readable audio stream.");

      const audioStream = new PassThrough({ highWaterMark: PREFETCH_BUFFER_BYTES });
      const telemetry = {
        synthesisStartedAt,
        metadataReadyAt,
        firstChunkAt: null,
        messageReceivedAt,
        voice,
        languageLabel: languageConfig.label,
        fallbackUsed: candidateIndex > 0,
      };

      sourceStream.once("data", () => {
        telemetry.firstChunkAt = performance.now();
        console.log(
          `[Latency] Edge first audio chunk: ${Math.round(telemetry.firstChunkAt - messageReceivedAt)} ms ` +
          `(${languageConfig.label} / ${voice}${candidateIndex > 0 ? ' fallback' : ''})`
        );
      });

      sourceStream.once("error", (error) => {
        // If this specific voice stream fails, temporarily remove it from the
        // effective catalog so the queue retry can select a same-locale fallback.
        markVoiceUnhealthy(voice);
        audioStream.destroy(error);
        try { edgeTts.close(); } catch {}
      });
      sourceStream.once("end", () => {
        try { edgeTts.close(); } catch {}
      });

      sourceStream.pipe(audioStream);
      return { audioStream, sourceStream, edgeTts, telemetry };
    } catch (error) {
      lastError = error;
      try { edgeTts.close(); } catch {}
      if (candidateIndex === 0 && candidates.length > 1) {
        console.warn(`[TTS] Preferred voice ${voice} failed before playback; trying a same-locale fallback.`);
      }
    }
  }

  throw lastError || new Error('No usable Edge voice was available for this locale.');
}


function cleanupPreparedAudio(prepared) {
  if (!prepared) return;
  try { prepared.sourceStream?.destroy?.(); } catch {}
  try { prepared.audioStream?.destroy?.(); } catch {}
  try { prepared.edgeTts?.close?.(); } catch {}
}

function prepareJobAudio(job, guildId) {
  if (!job.preparedAudioPromise) {
    job.preparedAudioPromise = createStreamingTts(
      job.speechText,
      guildId,
      job.isAnnouncement ? null : job.userId,
      job.messageReceivedAt
    ).catch((error) => {
      job.preparedAudioPromise = null;
      throw error;
    });
  }
  return job.preparedAudioPromise;
}

function prefetchNextQueuedJob(guildId, state) {
  if (!state || state.player.state.status !== AudioPlayerStatus.Playing) return;
  const nextJob = state.queue[0];
  if (!nextJob || nextJob.preparedAudioPromise) return;
  if (state.prefetchedJobId === nextJob.jobId) return;

  state.prefetchedJobId = nextJob.jobId;
  console.log(`[TTS] Pre-generating next queued message in guild ${guildId}.`);
  void prepareJobAudio(nextJob, guildId)
    .catch((error) => console.warn(`[TTS] Pre-generation failed in guild ${guildId}; normal retry will handle it:`, error?.message || error))
    .finally(() => {
      if (state.prefetchedJobId === nextJob.jobId) state.prefetchedJobId = null;
    });
}

/* =========================================================
   TOP.GG STATS
========================================================= */

async function updateTopGGStats() {
  try {
    if (!process.env.TOPGG_TOKEN) {
      console.warn("[Top.gg] TOPGG_TOKEN is missing.");
      return;
    }

    // Only shard 0 should post stats
    if (client.shard && !client.shard.ids.includes(0)) {
      return;
    }

    let serverCount;
    let shardCount;

    if (client.shard) {
      // Get guild counts from ALL shards
      const guildCounts = await client.shard.fetchClientValues(
        "guilds.cache.size"
      );

      serverCount = guildCounts.reduce(
        (total, count) => total + count,
        0
      );

      shardCount = guildCounts.length;
    } else {
      // Fallback if running without sharding
      serverCount = client.guilds.cache.size;
      shardCount = 1;
    }

    const response = await fetch(
      "https://top.gg/api/v1/projects/@me/metrics",
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.TOPGG_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          server_count: serverCount,
          shard_count: shardCount,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();

      console.error(
        `[Top.gg] Failed to update stats: ${response.status}`,
        error
      );

      return;
    }

    console.log(
      `[Top.gg] Updated stats | Servers: ${serverCount} | Shards: ${shardCount}`
    );
  } catch (error) {
    console.error("[Top.gg] Stats update error:", error);
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
  if (!state.connectedAt || state.voiceChannelId !== voiceChannel.id) {
    state.connectedAt = Date.now();
  }
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
    if (!guild) return;

    // If Discord's actual voice state says the bot is no longer in a VC,
    // this was a real disconnect/kick rather than a network-only hiccup.
    // Do not resurrect the session after a moderator disconnected the bot.
    const botId = client.user?.id;
    const actualBotChannelId = botId
      ? (guild.voiceStates.cache.get(botId)?.channelId || guild.members.me?.voice?.channelId || null)
      : null;

    if (!actualBotChannelId) {
      destroyGuildState(guildId);
      return;
    }

    // If Discord moved the bot, follow the actual voice state instead of a
    // stale remembered channel id.
    if (actualBotChannelId !== state.lastVoiceChannelId) {
      state.lastVoiceChannelId = actualBotChannelId;
      state.voiceChannelId = actualBotChannelId;
    }

    const voiceChannel = guild.channels.cache.get(actualBotChannelId);
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

    for (const queuedJob of state.queue) {
      if (queuedJob.preparedAudioPromise) {
        void queuedJob.preparedAudioPromise.then(cleanupPreparedAudio).catch(() => {});
      }
    }
    if (state.currentJob?.preparedAudioPromise) {
      void state.currentJob.preparedAudioPromise.then(cleanupPreparedAudio).catch(() => {});
    }
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
  void staffPlatform.removeSession(guildId);
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


function getStaffTtsSessions() {
  const sessions = [];
  const botId = client.user?.id;

  for (const [guildId, state] of guildStates.entries()) {
    if (!state?.voiceChannelId || !state.connection) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild || !botId) continue;

    const actualChannelId =
      guild.voiceStates.cache.get(botId)?.channelId ||
      guild.members.me?.voice?.channelId ||
      null;
    if (!actualChannelId) continue;

    const channel = guild.channels.cache.get(actualChannelId);
    if (!channel?.isVoiceBased()) continue;

    const humans = getHumanMembersInVoiceChannel(guild, actualChannelId);
    sessions.push({
      guild_id: guildId,
      guild_name: guild.name,
      channel_id: actualChannelId,
      channel_name: channel.name || null,
      humans_in_vc: humans?.size ?? 0,
      queue_depth: state.queue.length + (state.currentJob ? 1 : 0),
      connected_at: new Date(state.connectedAt || Date.now()).toISOString(),
    });
  }

  return sessions;
}

const staffPlatform = createStaffPlatform({
  client,
  getSessions: getStaffTtsSessions,
  getGuildInspector: async (guild) => {
    const settings = getGuildSettings(guild.id);
    const state = guildStates.get(guild.id);
    const selection = getGuildLanguageSelection(guild.id, null);
    return {
      tts: {
        serverLanguage: selection.language,
        serverAccent: selection.accent,
        serverVoice: settings.serverVoice || null,
        volumePercent: Math.round(Number(settings.volume ?? 1) * 100),
        announcementsEnabled: Boolean(settings.announcements?.enabled),
        activeSession: state?.voiceChannelId ? {
          voiceChannelId: state.voiceChannelId,
          queueDepth: state.queue.length + (state.currentJob ? 1 : 0),
          connectedAt: state.connectedAt ? new Date(state.connectedAt).toISOString() : null,
        } : null,
      },
    };
  },
  disconnectGuild: async (guildId, reason) => {
    if (!guildStates.has(String(guildId))) return false;
    console.warn(`[Staff Platform] Ending TTS session in guild ${guildId} (${reason}).`);
    destroyGuildState(String(guildId));
    return true;
  },
  onFeatureDisabled: async (featureKey) => {
    if (featureKey !== "tts_playback") return;
    console.warn("[Staff Platform] Global TTS Playback control disabled. Ending active TTS sessions on this shard.");
    for (const guildId of [...guildStates.keys()]) destroyGuildState(String(guildId));
  },
});

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
    `[Voice] VC is empty in guild ${guildId}. Leaving in 180 seconds.`
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
        `[Voice] Left guild ${guildId} after the VC remained empty for 180 seconds.`
      );
    }, EMPTY_CHANNEL_LEAVE_DELAY_MS);
}


/* =========================================================
   PLAYBACK
========================================================= */

function waitForPlaybackToFinish(player, { onPlaying: onPlaybackStarted, shouldResolveEarly } = {}) {
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
      if (!startedPlaying) {
        startedPlaying = true;
        try { onPlaybackStarted?.(); } catch {}
      }
    }

    function onIdle() {
      if (!startedPlaying) {
        if (shouldResolveEarly?.()) {
          cleanup();
          resolve();
        }
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
   PERSISTENT AUTO-JOIN V2 — ISOLATED FROM NORMAL /join
========================================================= */

const AUTO_JOIN_SCAN_DEBOUNCE_MS = 500;
const autoJoinRuntime = new Map();
const manualJoinInFlight = new Set();

function getEnabledAutoJoinConfig(guildId) {
  const config = getPersistentAutoJoinConfig(guildId);
  return config?.enabled && config.channelId ? config : null;
}

function getAutoJoinRuntime(guildId) {
  const id = String(guildId);
  let runtime = autoJoinRuntime.get(id);
  if (!runtime) {
    runtime = {
      timer: null,
      scanPromise: null,
      connectPromise: null,
      promptMessage: null,
      promptChannelId: null,
    };
    autoJoinRuntime.set(id, runtime);
  }
  return runtime;
}

function getActualBotVoiceChannelIdForAutoJoin(guild) {
  const botId = client.user?.id;
  if (!guild || !botId) return null;
  return (
    guild.voiceStates.cache.get(botId)?.channelId ||
    guild.members.me?.voice?.channelId ||
    null
  );
}

function cancelPendingAutoJoin(guildId) {
  const runtime = autoJoinRuntime.get(String(guildId));
  if (!runtime?.timer) return;
  clearTimeout(runtime.timer);
  runtime.timer = null;
}

async function deleteAutoJoinPrompt(guildId) {
  const runtime = autoJoinRuntime.get(String(guildId));
  if (!runtime?.promptMessage) return;
  const message = runtime.promptMessage;
  runtime.promptMessage = null;
  runtime.promptChannelId = null;
  await message.delete().catch(() => {});
}

function buildAutoJoinVerificationContainer(guildId, channelId) {
  return new ContainerBuilder()
    .setAccentColor(COLORS.INFO)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 💜 One Quick Step\n` +
        `Bozos TTS Auto-Join is enabled for <#${channelId}>, but Bozos will only auto-join when at least one person currently in this voice channel is a member of the **Bozos Support Server**.\n\n` +
        `Join with the button below, then press **I've Joined — Verify Again**. The first eligible person in the VC will automatically bring Bozos TTS in.`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Join Support Server")
          .setEmoji("💬")
          .setStyle(ButtonStyle.Link)
          .setURL(SUPPORT_SERVER_URL),
        new ButtonBuilder()
          .setCustomId(`autojoin_verify:${guildId}:${channelId}`)
          .setLabel("I've Joined — Verify Again")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success)
      )
    );
}

function buildAutoJoinSuccessContainer(channelId) {
  return new ContainerBuilder()
    .setAccentColor(COLORS.SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔊 Bozos TTS Auto-Joined\n` +
        `Successfully connected to <#${channelId}>.\n\n` +
        `### How it works\n` +
        `Messages posted in this voice channel's built-in chat will now be spoken aloud.`
      )
    );
}

function buildAutoJoinFailureContainer(channelId, reason) {
  return new ContainerBuilder()
    .setAccentColor(COLORS.ERROR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ⚠️ Auto-Join Couldn't Connect\n` +
        `Bozos TTS could not automatically connect to <#${channelId}>.\n\n` +
        `**Reason:** ${String(reason || "Unknown connection error").slice(0, 900)}`
      )
    );
}

async function ensureAutoJoinVerificationPrompt(guild, channel) {
  const runtime = getAutoJoinRuntime(guild.id);
  if (runtime.promptMessage && runtime.promptChannelId === channel.id) {
    return runtime.promptMessage;
  }
  if (runtime.promptMessage) await deleteAutoJoinPrompt(guild.id);

  const permissions = channel.permissionsFor(guild.members.me);
  if (
    typeof channel.send !== "function" ||
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions?.has(PermissionFlagsBits.SendMessages)
  ) {
    return null;
  }

  const message = await channel.send({
    components: [buildAutoJoinVerificationContainer(guild.id, channel.id)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  }).catch((error) => {
    console.warn(`[Auto-Join] Could not send verification prompt in ${guild.id}:`, error?.message || error);
    return null;
  });

  if (message) {
    runtime.promptMessage = message;
    runtime.promptChannelId = channel.id;
  }
  return message;
}

async function showAutoJoinResult(guildId, channel, container) {
  const runtime = getAutoJoinRuntime(guildId);
  const prompt = runtime.promptMessage;
  runtime.promptMessage = null;
  runtime.promptChannelId = null;

  if (prompt) {
    const edited = await prompt.edit({
      components: [container],
      allowedMentions: { parse: [] },
    }).then(() => true).catch(() => false);
    if (edited) return;
  }

  if (typeof channel.send === "function") {
    await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}

function autoJoinMustBackOff(guild) {
  const guildId = String(guild.id);
  return (
    manualJoinInFlight.has(guildId) ||
    guildStates.has(guildId) ||
    Boolean(getVoiceConnection(guildId)) ||
    Boolean(getActualBotVoiceChannelIdForAutoJoin(guild))
  );
}

async function waitForAutoJoinAttempt(guildId) {
  const runtime = autoJoinRuntime.get(String(guildId));
  if (!runtime?.connectPromise) return;
  await runtime.connectPromise.catch(() => false);
}

async function runNormalJoinWithAutoJoinGuard(interaction) {
  // Important: when Auto-Join is disabled/unconfigured, /join follows the exact
  // original path with no Auto-Join bookkeeping, timer, scan, or await.
  if (!getEnabledAutoJoinConfig(interaction.guildId)) {
    return handleJoinInteraction(interaction);
  }

  const guildId = String(interaction.guildId);
  manualJoinInFlight.add(guildId);
  cancelPendingAutoJoin(guildId);

  try {
    // If Auto-Join already owns an in-flight handshake, wait for that one
    // attempt to finish instead of starting a competing Discord voice handshake.
    // A slash-command interaction is deferred first so Discord's 3-second
    // acknowledgement window cannot expire while that isolated attempt finishes.
    const runtime = autoJoinRuntime.get(guildId);
    if (
      runtime?.connectPromise &&
      interaction.isChatInputCommand?.() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    await waitForAutoJoinAttempt(guildId);
    const result = await handleJoinInteraction(interaction);
    if (getActualBotVoiceChannelIdForAutoJoin(interaction.guild)) {
      await deleteAutoJoinPrompt(guildId);
    }
    return result;
  } finally {
    manualJoinInFlight.delete(guildId);
  }
}

async function connectConfiguredAutoJoin(guild, channel) {
  const guildId = String(guild.id);
  const config = getEnabledAutoJoinConfig(guildId);
  if (!config || config.channelId !== channel.id) return false;
  if (autoJoinMustBackOff(guild)) return false;

  const runtime = getAutoJoinRuntime(guildId);
  if (runtime.connectPromise) return runtime.connectPromise;

  runtime.connectPromise = (async () => {
    // This state is created only after proving there is no existing runtime
    // state or VoiceConnection, so cleanup below can only affect this Auto-Join attempt.
    const state = getGuildState(guildId);

    try {
      const latestConfig = getEnabledAutoJoinConfig(guildId);
      if (
        !latestConfig ||
        latestConfig.channelId !== channel.id ||
        manualJoinInFlight.has(guildId)
      ) {
        if (guildStates.get(guildId) === state && !state.voiceChannelId) {
          guildStates.delete(guildId);
        }
        return false;
      }

      await connectToVoiceChannel(channel, state);
      clearEmptyChannelTimer(state);
      await playJoinSound(guildId, state);
      await showAutoJoinResult(guildId, channel, buildAutoJoinSuccessContainer(channel.id));
      void staffPlatform.syncSessions();
      return true;
    } catch (error) {
      console.error(`[Auto-Join] Connection failed in guild ${guildId}:`, error);

      // Cleanup only the connection/state created by this Auto-Join attempt.
      // Cleanup is intentionally limited to the connection/state created here.
      // The normal production voice lifecycle remains untouched.
      state.manualDisconnect = true;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      const connection = getVoiceConnection(guildId);
      if (connection) {
        try { connection.destroy(); } catch {}
      }
      try { state.player.stop(true); } catch {}
      if (guildStates.get(guildId) === state) guildStates.delete(guildId);

      await showAutoJoinResult(
        guildId,
        channel,
        buildAutoJoinFailureContainer(channel.id, error?.message || error)
      );
      return false;
    } finally {
      runtime.connectPromise = null;
    }
  })();

  return runtime.connectPromise;
}

async function performAutoJoinScan(guildId, preferredUserId = null) {
  const id = String(guildId);
  const config = getEnabledAutoJoinConfig(id);

  // Zero-scan path: disabled really means disabled.
  if (!config) return false;
  if (isShuttingDown || !staffPlatform.isFeatureEnabled("tts_playback")) return false;

  const guild = client.guilds.cache.get(id);
  if (!guild || staffPlatform.guildRestriction(id)) return false;
  if (autoJoinMustBackOff(guild)) {
    if (getActualBotVoiceChannelIdForAutoJoin(guild)) await deleteAutoJoinPrompt(id);
    return false;
  }

  const channel = guild.channels.cache.get(config.channelId) ||
    await guild.channels.fetch(config.channelId).catch(() => null);

  if (!channel?.isVoiceBased()) {
    await setPersistentAutoJoinConfig(guild, false, null).catch(() => {});
    cancelPendingAutoJoin(id);
    await deleteAutoJoinPrompt(id);
    return false;
  }

  const humans = [...channel.members.values()].filter(
    (member) => !member.user.bot && !staffPlatform.userRestriction(member.id)
  );

  if (!humans.length) {
    await deleteAutoJoinPrompt(id);
    return false;
  }

  if (preferredUserId) {
    humans.sort((a, b) => {
      if (a.id === preferredUserId) return -1;
      if (b.id === preferredUserId) return 1;
      return 0;
    });
  }

  for (const member of humans) {
    if (manualJoinInFlight.has(id)) return false;

    const latestConfig = getEnabledAutoJoinConfig(id);
    if (!latestConfig || latestConfig.channelId !== channel.id) return false;

    const membershipStatus = await getSupportMembershipStatus(member.id);
    if (membershipStatus === "member") {
      if (manualJoinInFlight.has(id)) return false;
      return connectConfiguredAutoJoin(guild, channel);
    }
  }

  if (!manualJoinInFlight.has(id) && getEnabledAutoJoinConfig(id)) {
    await ensureAutoJoinVerificationPrompt(guild, channel);
  }
  return false;
}

async function scanAutoJoin(guildId, preferredUserId = null) {
  if (!getEnabledAutoJoinConfig(guildId)) return false;

  const runtime = getAutoJoinRuntime(guildId);
  if (runtime.scanPromise) return runtime.scanPromise;

  runtime.scanPromise = performAutoJoinScan(guildId, preferredUserId)
    .finally(() => {
      runtime.scanPromise = null;
    });

  return runtime.scanPromise;
}

function scheduleAutoJoin(guildId, delay = AUTO_JOIN_SCAN_DEBOUNCE_MS) {
  // Disabled/unconfigured guilds never even get a timer.
  if (!getEnabledAutoJoinConfig(guildId)) return false;

  const runtime = getAutoJoinRuntime(guildId);
  if (runtime.timer) clearTimeout(runtime.timer);

  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    if (!getEnabledAutoJoinConfig(guildId)) return;
    if (manualJoinInFlight.has(String(guildId))) return;

    void scanAutoJoin(guildId).catch((error) =>
      console.error(`[Auto-Join] Scan failed in guild ${guildId}:`, error)
    );
  }, delay);

  return true;
}

async function cleanupAutoJoinPromptIfEmpty(guildId) {
  const config = getEnabledAutoJoinConfig(guildId);
  if (!config) return;

  const guild = client.guilds.cache.get(String(guildId));
  const channel = guild?.channels.cache.get(config.channelId);
  const hasHumans = channel?.isVoiceBased()
    ? [...channel.members.values()].some((member) => !member.user.bot)
    : false;

  if (!hasHumans) await deleteAutoJoinPrompt(guildId);
}

/* =========================================================
   MESSAGE QUEUE
========================================================= */

/* =========================================================
   MESSAGE QUEUE (True Streaming + One-Message Prefetch)
========================================================= */

async function processGuildQueue(guildId, state) {
  if (state.processing || isShuttingDown) return;
  state.processing = true;

  try {
    while (state.queue.length > 0 && !isShuttingDown) {
      const job = state.queue.shift();
      state.currentJob = job;
      let prepared = null;

      try {
        if (!state.voiceChannelId || state.voiceChannelId !== job.voiceChannelId) continue;
        if (!job.isAnnouncement && (!job.member || job.member.voice.channelId !== state.voiceChannelId)) continue;

        const voiceChannel = job.guild.channels.cache.get(state.voiceChannelId);
        if (!voiceChannel?.isVoiceBased()) throw new Error("The tracked voice channel no longer exists.");

        await connectToVoiceChannel(voiceChannel, state);
        prepared = await prepareJobAudio(job, guildId);

        if (state.skipRequested || isShuttingDown) {
          state.skipRequested = false;
          cleanupPreparedAudio(prepared);
          prepared = null;
          continue;
        }

        const settings = getGuildSettings(guildId);
        const resource = createAudioResource(prepared.audioStream, {
          inputType: StreamType.WebmOpus,
          inlineVolume: true,
          silencePaddingFrames: 1,
        });
        resource.volume?.setVolume(settings.volume);
        state.currentResource = resource;

        state.skipRequested = false;
        const playCalledAt = performance.now();
        const playbackFinished = waitForPlaybackToFinish(state.player, {
          shouldResolveEarly: () => state.skipRequested || isShuttingDown,
          onPlaying: () => {
            const audibleAt = performance.now();
            const totalMs = audibleAt - job.messageReceivedAt;
            const playerStartupMs = audibleAt - playCalledAt;
            const firstChunkMs = prepared?.telemetry?.firstChunkAt
              ? prepared.telemetry.firstChunkAt - job.messageReceivedAt
              : null;

            recordPlaybackLatency(totalMs);
            console.log(
              `[Latency] REAL message-to-audio: ${Math.round(totalMs)} ms | ` +
              `player startup: ${Math.round(playerStartupMs)} ms` +
              (firstChunkMs == null ? "" : ` | Edge first chunk: ${Math.round(firstChunkMs)} ms`) +
              ` | p50: ${client.bozoMetrics?.playbackLatencyP50Ms ?? "-"} ms | ` +
              `p95: ${client.bozoMetrics?.playbackLatencyP95Ms ?? "-"} ms`
            );

            // A message may have arrived after player.play(), so check again now.
            prefetchNextQueuedJob(guildId, state);
          },
        });

        // Attach playback listeners before player.play() so a fully-prefetched
        // resource cannot enter Playing before the real-latency listener exists.
        state.player.play(resource);

        // Start synthesising exactly one message ahead while this one is audible.
        prefetchNextQueuedJob(guildId, state);
        await playbackFinished;

        if (state.skipRequested) state.skipRequested = false;
      } catch (error) {
        const attempts = (job.attempts || 0) + 1;
        job.attempts = attempts;

        console.error(`[TTS] Queue item failed in guild ${guildId} (attempt ${attempts}/${MAX_JOB_RETRIES}):`, error);
        cleanupPreparedAudio(prepared);
        prepared = null;
        job.preparedAudioPromise = null;

        if (attempts < MAX_JOB_RETRIES && state.voiceChannelId === job.voiceChannelId && !isShuttingDown) {
          state.queue.unshift(job);
          await wait(RETRY_DELAY_MS * attempts);
          if (!state.connection) scheduleVoiceReconnect(guildId);
        }
      } finally {
        cleanupPreparedAudio(prepared);
        job.preparedAudioPromise = null;
        state.currentResource = null;
        state.currentJob = null;
      }
    }
  } finally {
    state.processing = false;
    if (!isShuttingDown) updateEmptyChannelTimer(guildId);
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

function splitLongSpeechText(text, locale = "en-US") {
  const source = String(text || "").replace(/\s+/g, " " ).trim();
  if (!source) return [];
  if (source.length <= TTS_CHUNK_MAX_CHARS) return [source];

  let sentences = [];
  try {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
    sentences = [...segmenter.segment(source)].map((item) => item.segment.trim()).filter(Boolean);
  } catch {
    sentences = source.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu)?.map((item) => item.trim()).filter(Boolean) || [source];
  }

  const pieces = [];
  const splitOversized = (segment) => {
    let remaining = segment.trim();
    while (remaining.length > TTS_CHUNK_MAX_CHARS) {
      let cut = remaining.lastIndexOf(' ', TTS_CHUNK_MAX_CHARS);
      if (cut < Math.floor(TTS_CHUNK_MAX_CHARS * 0.55)) {
        const comma = Math.max(remaining.lastIndexOf(', ', TTS_CHUNK_MAX_CHARS), remaining.lastIndexOf('; ', TTS_CHUNK_MAX_CHARS));
        cut = comma > 0 ? comma + 1 : TTS_CHUNK_MAX_CHARS;
      }
      pieces.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) pieces.push(remaining);
  };

  for (const sentence of sentences) splitOversized(sentence);

  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (!current) { current = piece; continue; }
    const candidate = `${current} ${piece}`;
    if (candidate.length <= TTS_CHUNK_TARGET_CHARS || (current.length < TTS_CHUNK_TARGET_CHARS * 0.55 && candidate.length <= TTS_CHUNK_MAX_CHARS)) {
      current = candidate;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);

  return chunks.filter(Boolean);
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
  text = applyHumanPronunciation(text, message.guildId, userId);

  const attachmentText = describeAttachments(message);
  text = `${text}${attachmentText}`.trim();
  text = text.replace(/\s+/g, " ").trim();

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
    console.log(`[Pronunciation] Grand pronunciation engine ${PRONUNCIATION_ENGINE_VERSION} loaded.`);
    console.log(
      `[Voice Catalog] Static verified catalog loaded: ` +
      `${VERIFIED_VOICE_SNAPSHOT.verifiedVoices} voices across ${VERIFIED_VOICE_SNAPSHOT.locales} locales, ` +
      `categorized into ${VERIFIED_VOICE_SNAPSHOT.languageFamilies} languages. ` +
      `Runtime voice verification is disabled.`
    );

    void resolveSupportGuild().then((guild) => {
      if (guild) {
        console.log(`[Support Gate] Membership verification ready for ${guild.name} (${guild.id}).`);
      } else {
        console.warn("[Support Gate] Support server could not be resolved; /join will fail open until verification is available.");
      }
    });

    readyClient.user.setPresence({
  activities: [
    {
      name: "custom",
      type: ActivityType.Custom,
      state: "/help • Bozos TTS",
    },
  ],
  status: "online",
});

    await staffPlatform.start();
    await refreshPersistentAutoJoinConfigs();

    for (const guild of readyClient.guilds.cache.values()) {
      if (getEnabledAutoJoinConfig(guild.id)) {
        scheduleAutoJoin(guild.id, 1_000);
      }
    }

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
   VOICE COMMAND ACCESS
========================================================= */

function getActualBotVoiceChannelId(interaction) {
  const botId = client.user?.id;
  if (!botId || !interaction.guild) return null;

  // Discord's guild voice-state cache is the source of truth here.
  // Do not fall back to our internal state/getVoiceConnection because those
  // can briefly be stale after a moderator disconnects the bot from the UI.
  return (
    interaction.guild.voiceStates.cache.get(botId)?.channelId ||
    interaction.guild.members.me?.voice?.channelId ||
    null
  );
}

function requireSameVoiceChannel(interaction) {
  const userChannelId = interaction.member?.voice?.channelId || null;
  const botChannelId = getActualBotVoiceChannelId(interaction);

  if (!userChannelId) {
    return "You need to be in a voice channel to use this command.";
  }

  if (!botChannelId) {
    return "Bozos is not currently in a voice channel. Use `/join` first.";
  }

  if (userChannelId !== botChannelId) {
    return "You need to be in the same voice channel as Bozos to use this command.";
  }

  return null;
}

function requireJoinVoiceChannel(interaction) {
  if (!interaction.member?.voice?.channelId) {
    return "You need to be in a voice channel to use /join.";
  }
  return null;
}

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
          .setDescription(
            `${entry.locale} • ${entry.voiceCount} verified voice${entry.voiceCount === 1 ? "" : "s"}`.slice(0, 100)
          )
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

function voiceDescription(entry, locale) {
  const traits = [...(entry.personalities || []), ...(entry.categories || [])]
    .filter(Boolean)
    .slice(0, 2)
    .join(', ');
  const base = `${locale} • ${entry.gender} neural voice`;
  return (traits ? `${base} • ${traits}` : base).slice(0, 100);
}

function generateVoiceMenuComponents(guildId, userId, scope = "server", page = 0) {
  const targetUserId = scope === "personal" ? userId : null;
  const selection = getGuildLanguageSelection(guildId, targetUserId);
  const locale = getSelectionLocale(selection);
  const languageLabel = (LANGUAGE_CONFIGS[selection.language] || LANGUAGE_CONFIGS.english).label;
  const available = getVerifiedVoiceModelsForLocale(locale);
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(available.length / pageSize));
  const currentPage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  const pageVoices = available.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const components = [];
  if (pageVoices.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`voice_select_${scope}_${currentPage}`)
      .setPlaceholder(`Select ${languageLabel} voice • ${locale}${totalPages > 1 ? ` (Page ${currentPage + 1}/${totalPages})` : ''}`)
      .addOptions(
        pageVoices.map((entry) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${getVoicePersonaName(entry.voice)} — ${entry.gender}`.slice(0, 100))
            .setValue(entry.voice)
            .setDescription(`${voiceDescription(entry, locale)} • Verified`.slice(0, 100))
        )
      );
    components.push(new ActionRowBuilder().addComponents(menu));
  }
  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`voice_page_${scope}_${currentPage - 1}`)
          .setLabel('⬅️ Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage === 0),
        new ButtonBuilder()
          .setCustomId(`voice_page_${scope}_${currentPage + 1}`)
          .setLabel('Next ➡️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= totalPages - 1),
      )
    );
  }

  return { locale, languageLabel, selection, voices: available, components, currentPage, totalPages };
}



function buildSupportMembershipGate(userId, stillMissing = false) {
  const message = stillMissing
    ? "I still can’t see you in the **Bozos Support Server** yet. If you just joined, give Discord a moment and press **I’ve Joined — Continue** again."
    : "To use `/join`, the person bringing Bozos TTS into a voice channel must be a member of the **Bozos Support Server**. It’s a one-time, quick step that keeps support, updates, and outage notices in one place.";

  return new ContainerBuilder()
    .setAccentColor(COLORS.INFO)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 💜 One Quick Step\n${message}\n\nJoin with the button below, then press **I’ve Joined — Continue**. Bozos will continue the same \`/join\` automatically.`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Join Support Server")
          .setEmoji("💬")
          .setStyle(ButtonStyle.Link)
          .setURL(SUPPORT_SERVER_URL),
        new ButtonBuilder()
          .setCustomId(`support_join_continue:${userId}`)
          .setLabel("I've Joined — Continue")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success)
      )
    );
}

async function showSupportMembershipGate(interaction, stillMissing = false) {
  const container = buildSupportMembershipGate(interaction.user.id, stillMissing);

  if (interaction.replied || interaction.deferred) {
    return interaction.editReply({ components: [container] });
  }

  return interaction.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function handleJoinInteraction(interaction) {
  const voiceError = requireJoinVoiceChannel(interaction);
  if (voiceError) {
    return replyWithV2(interaction, {
      title: "Voice Channel Required",
      description: voiceError,
      color: COLORS.ERROR,
      ephemeral: true,
    });
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return replyWithV2(interaction, {
      title: "Voice Channel Required",
      description: "Join a voice channel first, then run `/join` again.",
      color: COLORS.ERROR,
      ephemeral: true,
    });
  }

  const membershipStatus = await getSupportMembershipStatus(interaction.user.id);
  if (membershipStatus === "not_member") {
    return showSupportMembershipGate(interaction, interaction.deferred);
  }

  // A transient Discord/support-guild lookup problem should never take the TTS
  // service down. The rule is enforced whenever Discord can answer the lookup;
  // only verification outages fail open to preserve user experience.
  if (membershipStatus === "unavailable") {
    console.warn(
      `[Support Gate] Verification unavailable for ${interaction.user.id}; allowing /join to avoid a service-impacting false block.`
    );
  }

  const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);

  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions?.has(PermissionFlagsBits.Connect) ||
    !permissions?.has(PermissionFlagsBits.Speak)
  ) {
    return replyWithV2(interaction, {
      title: "Missing Permissions",
      description:
        `I need these permissions in <#${voiceChannel.id}>:\n\n` +
        "• **View Channel**\n" +
        "• **Connect**\n" +
        "• **Speak**",
      color: COLORS.ERROR,
      ephemeral: true,
    });
  }

  const existingConnection = getVoiceConnection(interaction.guildId);
  const existingState = guildStates.get(interaction.guildId);
  const connectedChannelId =
    existingConnection?.joinConfig?.channelId || existingState?.voiceChannelId || null;

  if (existingConnection && connectedChannelId === voiceChannel.id) {
    if (existingState) clearEmptyChannelTimer(existingState);

    return replyWithV2(interaction, {
      title: "Already Connected",
      description:
        `I am already connected to <#${voiceChannel.id}>.\n\n` +
        "Messages posted in this voice channel's chat will continue to be spoken aloud.",
      color: COLORS.WARNING,
    });
  }

  await replyWithV2(interaction, {
    title: "Connecting",
    description: `Joining <#${voiceChannel.id}> and preparing voice-chat TTS...`,
    color: COLORS.INFO,
  });

  try {
    const previousState = guildStates.get(interaction.guildId);

    if (
      previousState?.voiceChannelId &&
      previousState.voiceChannelId !== voiceChannel.id
    ) {
      previousState.queue.length = 0;
      try {
        previousState.player.stop(true);
      } catch {
        // Player may already be idle.
      }
    }

    const state = getGuildState(interaction.guildId);
    await connectToVoiceChannel(voiceChannel, state);
    clearEmptyChannelTimer(state);
    await playJoinSound(interaction.guildId, state);

    const successContainer = new ContainerBuilder()
      .setAccentColor(COLORS.SUCCESS)
      .addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(
          [
            "## 🔊 Voice Chat Connected",
            `Successfully connected to <#${voiceChannel.id}>.`,
          ].join("\n")
        )
      )
      .addSeparatorComponents((separator) => separator.setDivider(true))
      .addTextDisplayComponents((textDisplay) =>
        textDisplay.setContent(
          [
            "### How it works",
            "Messages posted in this voice channel's built-in chat will now be spoken aloud.",
          ].join("\n")
        )
      );

    await interaction.editReply({ components: [successContainer] });
  } catch (error) {
    console.error("Failed to join voice channel:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorContainer = createV2Container({
      title: "Connection Failed",
      description:
        `I could not join <#${voiceChannel.id}>.\n\n` +
        `**Reason:** ${errorMessage}`,
      color: COLORS.ERROR,
    });
    await interaction.editReply({ components: [errorContainer] });
  }
}


client.on(
  Events.InteractionCreate,
  async (interaction) => {
    if (interaction.inGuild()) {
      const guildRestriction = staffPlatform.guildRestriction(interaction.guildId);
      if (guildRestriction) {
        return interaction.reply({ content: staffPlatform.restrictionText(guildRestriction, "This server"), flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      const userRestriction = staffPlatform.userRestriction(interaction.user?.id);
      if (userRestriction) {
        return interaction.reply({ content: staffPlatform.restrictionText(userRestriction, "You"), flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      const customId = String(interaction.customId || "");
      if ((customId.startsWith("lang_") || customId.startsWith("voice_")) && !staffPlatform.isFeatureEnabled("voice_selection")) {
        return interaction.reply({ content: staffPlatform.featureDisabledText("voice_selection", "Language & Voice Selection"), flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    // Seamless support-server membership gate for /join. The button belongs only
    // to the user who originally ran /join and continues the same command flow.
    if (interaction.isButton() && interaction.customId.startsWith("support_join_continue:")) {
      const expectedUserId = interaction.customId.split(":")[1] || "";
      if (interaction.user.id !== expectedUserId) {
        return interaction.reply({
          content: "This verification button belongs to the person who ran `/join`.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "This button can only be used inside a server.",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferUpdate();
      return getEnabledAutoJoinConfig(interaction.guildId)
        ? runNormalJoinWithAutoJoinGuard(interaction)
        : handleJoinInteraction(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith("autojoin_verify:")) {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "This button can only be used inside a server.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const [, expectedGuildId, expectedChannelId] = interaction.customId.split(":");
      const config = getEnabledAutoJoinConfig(interaction.guildId);
      if (
        !config ||
        expectedGuildId !== interaction.guildId ||
        config.channelId !== expectedChannelId
      ) {
        return interaction.reply({
          content: "This Auto-Join verification is no longer active.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.member?.voice?.channelId !== expectedChannelId) {
        return interaction.reply({
          content: `You need to still be inside <#${expectedChannelId}> to verify Auto-Join.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (manualJoinInFlight.has(String(interaction.guildId))) {
        return interaction.reply({
          content: "A normal `/join` is already in progress. Auto-Join will not compete with it.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const membershipStatus = await getSupportMembershipStatus(interaction.user.id);
      if (membershipStatus === "not_member") {
        return interaction.reply({
          content: "I still can't see you in the Bozos Support Server yet. Join it, wait a moment, then verify again.",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (membershipStatus === "unavailable") {
        return interaction.reply({
          content: "Support Server verification is temporarily unavailable. Please try again shortly.",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const joined = await scanAutoJoin(interaction.guildId, interaction.user.id);
      return interaction.editReply(
        joined
          ? "✅ Verified. Bozos TTS Auto-Joined."
          : "✅ Verified. Auto-Join did not start because a normal voice session or `/join` currently owns this server."
      );
    }

    // Handle Pagination Buttons for /language menu
    if (interaction.isButton() && interaction.customId.startsWith("lang_page_")) {
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) {
        return interaction.reply({ content: `🔊 ${voiceError}`, flags: MessageFlags.Ephemeral });
      }
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

    // Handle Pagination Buttons for /voice menu
    if (interaction.isButton() && interaction.customId.startsWith("voice_page_")) {
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) {
        return interaction.reply({ content: `🔊 ${voiceError}`, flags: MessageFlags.Ephemeral });
      }
      const [, , scope, page] = interaction.customId.split("_");
      const pageNum = parseInt(page, 10);
      const menu = generateVoiceMenuComponents(interaction.guildId, interaction.user.id, scope || "server", pageNum);
      await interaction.update({
        components: [
          new ContainerBuilder()
            .setAccentColor(COLORS.INFO)
            .addTextDisplayComponents((td) => td.setContent(
              `## 🎙️ Choose Neural Voice\n**${menu.languageLabel}** • **${menu.locale}** • ${menu.voices.length} static verified voice${menu.voices.length === 1 ? '' : 's'}${menu.totalPages > 1 ? ` • Page ${menu.currentPage + 1}/${menu.totalPages}` : ''}`
            )),
          ...menu.components,
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
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) {
        return interaction.reply({ content: `🔊 ${voiceError}`, flags: MessageFlags.Ephemeral });
      }
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
        const newSelection = { language: selectedLanguage, accent: selectedAccent };
        if (!isVoiceCompatibleWithSelection(settings.userVoices[interaction.user.id], newSelection)) {
          delete settings.userVoices[interaction.user.id];
        }
      } else {
        settings.serverLanguage = selectedLanguage;
        settings.serverAccent = selectedAccent;
        const newSelection = { language: selectedLanguage, accent: selectedAccent };
        if (!isVoiceCompatibleWithSelection(settings.serverVoice, newSelection)) {
          settings.serverVoice = null;
        }
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

    // Handle neural voice selection for /voice
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("voice_select_")) {
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) {
        return interaction.reply({ content: `🔊 ${voiceError}`, flags: MessageFlags.Ephemeral });
      }

      const voiceSelectParts = interaction.customId.split("_");
      const scope = voiceSelectParts[2] || "server";
      const targetUserId = scope === "personal" ? interaction.user.id : null;
      const selection = getGuildLanguageSelection(interaction.guildId, targetUserId);
      const locale = getSelectionLocale(selection);
      const selectedVoice = String(interaction.values?.[0] || "");
      const availableVoices = getVerifiedVoiceModelsForLocale(locale);
      const isAvailable = availableVoices.some((entry) => entry.voice === selectedVoice);

      if (!isAvailable || !isVoiceCompatibleWithSelection(selectedVoice, selection)) {
        return interaction.reply({
          content: "That voice no longer matches the selected language/accent. Run `/voice` again.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const settings = getGuildSettings(interaction.guildId);
      const currentVoice = getEffectiveVoice(interaction.guildId, targetUserId);
      const selectedInfo = getVoiceModelInfo(selectedVoice);

      if (currentVoice === selectedVoice) {
        return interaction.update({
          components: [
            new ContainerBuilder()
              .setAccentColor(COLORS.WARNING)
              .addTextDisplayComponents((td) => td.setContent(
                `## 🎙️ Voice Already Selected\n${scope === "personal" ? "Your personal" : "Server default"} voice is already **${selectedInfo.name} (${selectedInfo.gender})**.`
              )),
          ],
        }).catch(() => {});
      }

      // /voice is backed entirely by the permanent static catalog.
      // Selecting a voice performs no Edge catalog request and no synthesis test.
      if (scope === "personal") {
        settings.userVoices[interaction.user.id] = selectedVoice;
      } else {
        settings.serverVoice = selectedVoice;
      }

      return interaction.update({
        components: [
          new ContainerBuilder()
            .setAccentColor(COLORS.SUCCESS)
            .addTextDisplayComponents((td) => td.setContent(
              `## ✅ Voice Updated\n${scope === "personal" ? "Your personal" : "Server default"} voice is now **${selectedInfo.name} — ${selectedInfo.gender}** (${selectedInfo.locale}).`
            )),
        ],
      }).catch(() => {});
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

    if (isShuttingDown) {
      return replyWithV2(interaction, {
        title: "Bozos TTS Is Restarting",
        description: "A graceful redeploy is in progress. Try the command again in a few seconds.",
        color: COLORS.WARNING,
        ephemeral: true,
      });
    }

    const commandFeature = (() => {
      if (["join", "auto-join", "volume", "skip"].includes(interaction.commandName)) return ["tts_playback", "TTS Playback"];
      if (["language", "voice"].includes(interaction.commandName)) return ["voice_selection", "Language & Voice Selection"];
      if (interaction.commandName === "announce") return ["announcements", "Voice Announcements"];
      return null;
    })();
    if (commandFeature && !staffPlatform.isFeatureEnabled(commandFeature[0])) {
      return replyWithV2(interaction, {
        title: "Feature Temporarily Disabled",
        description: staffPlatform.featureDisabledText(commandFeature[0], commandFeature[1]),
        color: COLORS.WARNING,
        ephemeral: true,
      });
    }


    /* -----------------------------------------------------
       /JOIN
    ----------------------------------------------------- */

    if (interaction.commandName === "join") {
      return getEnabledAutoJoinConfig(interaction.guildId)
        ? runNormalJoinWithAutoJoinGuard(interaction)
        : handleJoinInteraction(interaction);
    }


    /* -----------------------------------------------------
       /AUTO-JOIN
    ----------------------------------------------------- */

    if (interaction.commandName === "auto-join") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyWithV2(interaction, {
          title: "Permission Required",
          description: "You need **Manage Server** to configure Auto-Join.",
          color: COLORS.ERROR,
          ephemeral: true,
        });
      }

      const enabled = interaction.options.getBoolean("enabled", true);
      const current = getPersistentAutoJoinConfig(interaction.guildId);

      if (!enabled) {
        if (!current?.enabled) {
          return replyWithV2(interaction, {
            title: "Already Disabled",
            description: "Auto-Join is already disabled for this server.",
            color: COLORS.WARNING,
            ephemeral: true,
          });
        }

        try {
          await setPersistentAutoJoinConfig(interaction.guild, false, null);
        } catch (error) {
          return replyWithV2(interaction, {
            title: "Auto-Join Database Error",
            description: error?.message || String(error),
            color: COLORS.ERROR,
            ephemeral: true,
          });
        }

        cancelPendingAutoJoin(interaction.guildId);
        await deleteAutoJoinPrompt(interaction.guildId);
        return replyWithV2(interaction, {
          title: "🔁 Auto-Join Disabled",
          description: "Bozos TTS Auto-Join is now disabled for this server. Any current live TTS session is left untouched.",
          color: COLORS.SUCCESS,
        });
      }

      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) {
        return replyWithV2(interaction, {
          title: "Voice Channel Required",
          description: `${voiceError}\n\nUse \`/join\` normally first. Once Bozos is connected, run this command again in the same VC.`,
          color: COLORS.ERROR,
          ephemeral: true,
        });
      }

      const channel = interaction.member.voice.channel;
      const permissions = channel.permissionsFor(interaction.guild.members.me);
      if (
        !permissions?.has(PermissionFlagsBits.ViewChannel) ||
        !permissions?.has(PermissionFlagsBits.Connect) ||
        !permissions?.has(PermissionFlagsBits.Speak) ||
        !permissions?.has(PermissionFlagsBits.SendMessages)
      ) {
        return replyWithV2(interaction, {
          title: "Missing Permissions",
          description: "Auto-Join needs **View Channel**, **Connect**, **Speak**, and **Send Messages** in this VC.",
          color: COLORS.ERROR,
          ephemeral: true,
        });
      }

      if (current?.enabled && current.channelId === channel.id) {
        return replyWithV2(interaction, {
          title: "Already Enabled",
          description: `Auto-Join is already enabled for <#${channel.id}>.`,
          color: COLORS.WARNING,
          ephemeral: true,
        });
      }

      try {
        await setPersistentAutoJoinConfig(interaction.guild, true, channel.id);
      } catch (error) {
        return replyWithV2(interaction, {
          title: "Auto-Join Database Error",
          description: error?.message || String(error),
          color: COLORS.ERROR,
          ephemeral: true,
        });
      }

      return replyWithV2(interaction, {
        title: "🔁 Auto-Join Enabled",
        description: `Auto-Join is now enabled for <#${channel.id}> and will persist across restarts. Normal \`/join\` always has priority.`,
        color: COLORS.SUCCESS,
      });
    }


    /* -----------------------------------------------------
       /LEAVE
    ----------------------------------------------------- */

    if (
      interaction.commandName ===
      "leave"
    ) {
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) return replyWithV2(interaction, { title: "Voice Channel Required", description: voiceError, color: COLORS.ERROR, ephemeral: true });
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
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) return replyWithV2(interaction, { title: "Voice Channel Required", description: voiceError, color: COLORS.ERROR, ephemeral: true });
      const scope = interaction.options.getString("scope", true);
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
       /VOICE
    ----------------------------------------------------- */

    if (interaction.commandName === "voice") {
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) {
        return replyWithV2(interaction, {
          title: "Voice Channel Required",
          description: voiceError,
          color: COLORS.ERROR,
          ephemeral: true,
        });
      }

      const scope = interaction.options.getString("scope", true);
      const targetUserId = scope === "personal" ? interaction.user.id : null;

      const { components, locale, selection, voices } = generateVoiceMenuComponents(
        interaction.guildId,
        interaction.user.id,
        scope
      );
      const currentVoice = getEffectiveVoice(interaction.guildId, targetUserId);
      const currentInfo = getVoiceModelInfo(currentVoice);
      const languageLabel = getLanguageVariantLabel(selection.language, selection.accent);

      const menuContainer = new ContainerBuilder()
        .setAccentColor(voices.length ? COLORS.SUCCESS : COLORS.WARNING)
        .addTextDisplayComponents((td) => td.setContent(
          voices.length
            ? [
                "## 🎙️ Choose Bozos TTS Voice",
                scope === "personal"
                  ? "This changes your personal neural voice only."
                  : "This changes the server default neural voice.",
                `Language: **${languageLabel}**`,
                `Current voice: **${currentInfo.name} — ${currentInfo.gender}** (${locale})`,
              ].join("\n")
            : `## ⚠️ No Available ${locale} Voices\nEvery statically verified voice for **${languageLabel}** has failed during this process run. Choose another language/accent to clear the runtime failure fallback.`
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
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) return replyWithV2(interaction, { title: "Voice Channel Required", description: voiceError, color: COLORS.ERROR, ephemeral: true });
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyWithV2(interaction, { title: "Permission Required", description: "You need **Manage Server** to change Bozos volume.", color: COLORS.ERROR, ephemeral: true });
      }
      const percent = interaction.options.getInteger("percent", true);
      const settings = getGuildSettings(interaction.guildId);
      const currentPercent = Math.round((settings.volume ?? 1) * 100);

      if (currentPercent === percent) {
        return replyWithV2(interaction, {
          title: "Volume Already Set",
          description: `Bozos playback volume is already set to **${percent}%**.`,
          color: COLORS.WARNING,
          ephemeral: true,
        });
      }

      settings.volume = percent / 100;

      const state = guildStates.get(interaction.guildId);
      if (state?.currentResource?.volume) {
        // Apply the new gain immediately to speech that is already playing.
        state.currentResource.volume.setVolume(settings.volume);
      }

      return replyWithV2(interaction, {
        title: "🔊 Volume Updated",
        description: `Bozos playback volume is now **${percent}%**.\n\nThe change also applies immediately to any TTS that is currently playing.`,
        color: COLORS.SUCCESS,
      });
    }

    /* -----------------------------------------------------
       /SKIP
    ----------------------------------------------------- */

    if (interaction.commandName === "skip") {
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) return replyWithV2(interaction, { title: "Voice Channel Required", description: voiceError, color: COLORS.ERROR, ephemeral: true });
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
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) return replyWithV2(interaction, { title: "Voice Channel Required", description: voiceError, color: COLORS.ERROR, ephemeral: true });
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyWithV2(interaction, { title: "Permission Required", description: "You need **Manage Server** to change announcement settings.", color: COLORS.ERROR, ephemeral: true });
      }
      const enabled = interaction.options.getBoolean("enabled", true);
      const settings = getGuildSettings(interaction.guildId);

      if (settings.announcements.enabled === enabled) {
        return replyWithV2(interaction, {
          title: enabled ? "Announcements Already Enabled" : "Announcements Already Disabled",
          description: `Join and leave announcements are already **${enabled ? "enabled" : "disabled"}** for this server.`,
          color: COLORS.WARNING,
          ephemeral: true,
        });
      }

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
      message.webhookId ||
      isShuttingDown
    ) {
      return;
    }

    if (staffPlatform.guildRestriction(message.guildId) || staffPlatform.userRestriction(message.author.id)) {
      return;
    }

    if (!staffPlatform.isFeatureEnabled("tts_playback")) return;

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

    const locale = getGuildLanguageConfig(message.guildId, message.author.id).lang || "en-US";
    const speechChunks = splitLongSpeechText(cleanedMessage, locale);
    if (!speechChunks.length) return;

    state.lastQueuedSpeakerId = message.author.id;
    state.lastQueuedSpeakerAt = queuedAt;

    speechChunks.forEach((chunk, index) => {
      const speechText = buildSpeechText(
        speakerName,
        chunk,
        message.guildId,
        message.author.id,
        includeSpeakerName && index === 0
      );

      state.queue.push({
        jobId: `${message.id}:${index}`,
        messageId: message.id,
        chunkIndex: index,
        chunkCount: speechChunks.length,
        guild: message.guild,
        member,
        userId: message.author.id,
        voiceChannelId: state.voiceChannelId,
        speechText,
        messageReceivedAt: queuedAt,
        attempts: 0,
        preparedAudioPromise: null,
      });
    });

    if (state.player.state.status === AudioPlayerStatus.Playing) {
      prefetchNextQueuedJob(message.guildId, state);
    }

    console.log(
      `[TTS] Queued message from ${speakerName}${includeSpeakerName ? " (speaker announced)" : ""}` +
      `${speechChunks.length > 1 ? ` in ${speechChunks.length} natural chunks` : ''}: ${cleanedMessage}`
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

const LOCALIZED_ANNOUNCEMENTS = {
  english: { join: (n) => `${n} joined the voice channel.`, leave: (n) => `${n} left the voice channel.` },
  hindi: { join: (n) => `${n} वॉइस चैनल में शामिल हुए।`, leave: (n) => `${n} वॉइस चैनल से चले गए।` },
  spanish: { join: (n) => `${n} se unió al canal de voz.`, leave: (n) => `${n} salió del canal de voz.` },
  french: { join: (n) => `${n} a rejoint le salon vocal.`, leave: (n) => `${n} a quitté le salon vocal.` },
  german: { join: (n) => `${n} ist dem Sprachkanal beigetreten.`, leave: (n) => `${n} hat den Sprachkanal verlassen.` },
  chinese: { join: (n) => `${n} 加入了语音频道。`, leave: (n) => `${n} 离开了语音频道。` },
  japanese: { join: (n) => `${n} がボイスチャンネルに参加しました。`, leave: (n) => `${n} がボイスチャンネルから退出しました。` },
  arabic: { join: (n) => `انضم ${n} إلى القناة الصوتية.`, leave: (n) => `غادر ${n} القناة الصوتية.` },
  russian: { join: (n) => `${n} присоединился к голосовому каналу.`, leave: (n) => `${n} покинул голосовой канал.` },
  portuguese: { join: (n) => `${n} entrou no canal de voz.`, leave: (n) => `${n} saiu do canal de voz.` },
  italian: { join: (n) => `${n} è entrato nel canale vocale.`, leave: (n) => `${n} ha lasciato il canale vocale.` },
  korean: { join: (n) => `${n}님이 음성 채널에 참여했습니다.`, leave: (n) => `${n}님이 음성 채널에서 나갔습니다.` },
  bengali: { join: (n) => `${n} ভয়েস চ্যানেলে যোগ দিয়েছেন।`, leave: (n) => `${n} ভয়েস চ্যানেল ছেড়েছেন।` },
  turkish: { join: (n) => `${n} ses kanalına katıldı.`, leave: (n) => `${n} ses kanalından ayrıldı.` },
  vietnamese: { join: (n) => `${n} đã tham gia kênh thoại.`, leave: (n) => `${n} đã rời kênh thoại.` },
  polish: { join: (n) => `${n} dołączył do kanału głosowego.`, leave: (n) => `${n} opuścił kanał głosowy.` },
  ukrainian: { join: (n) => `${n} приєднався до голосового каналу.`, leave: (n) => `${n} покинув голосовий канал.` },
  dutch: { join: (n) => `${n} is het spraakkanaal binnengekomen.`, leave: (n) => `${n} heeft het spraakkanaal verlaten.` },
  greek: { join: (n) => `${n} μπήκε στο κανάλι φωνής.`, leave: (n) => `${n} έφυγε από το κανάλι φωνής.` },
  swedish: { join: (n) => `${n} gick med i röstkanalen.`, leave: (n) => `${n} lämnade röstkanalen.` },
  indonesian: { join: (n) => `${n} bergabung ke kanal suara.`, leave: (n) => `${n} meninggalkan kanal suara.` },
  hebrew: { join: (n) => `${n} הצטרף לערוץ הקולי.`, leave: (n) => `${n} עזב את הערוץ הקולי.` },
  romanian: { join: (n) => `${n} s-a alăturat canalului vocal.`, leave: (n) => `${n} a părăsit canalul vocal.` },
  filipino: { join: (n) => `${n} ay sumali sa voice channel.`, leave: (n) => `${n} ay umalis sa voice channel.` },
  malay: { join: (n) => `${n} menyertai saluran suara.`, leave: (n) => `${n} meninggalkan saluran suara.` },
  thai: { join: (n) => `${n} เข้าร่วมช่องเสียงแล้ว`, leave: (n) => `${n} ออกจากช่องเสียงแล้ว` },
  tamil: { join: (n) => `${n} குரல் சேனலில் சேர்ந்தார்.`, leave: (n) => `${n} குரல் சேனலில் இருந்து வெளியேறினார்.` },
  telugu: { join: (n) => `${n} వాయిస్ ఛానెల్‌లో చేరారు.`, leave: (n) => `${n} వాయిస్ ఛానెల్‌ను వదిలారు.` },
  marathi: { join: (n) => `${n} व्हॉइस चॅनेलमध्ये सामील झाले.`, leave: (n) => `${n} व्हॉइस चॅनेलमधून बाहेर पडले.` },
  gujarati: { join: (n) => `${n} વૉઇસ ચેનલમાં જોડાયા.`, leave: (n) => `${n} વૉઇસ ચેનલમાંથી નીકળી ગયા.` },
  kannada: { join: (n) => `${n} ಧ್ವನಿ ಚಾನೆಲ್‌ಗೆ ಸೇರಿದರು.`, leave: (n) => `${n} ಧ್ವನಿ ಚಾನೆಲ್‌ನಿಂದ ಹೊರಬಂದರು.` },
  malayalam: { join: (n) => `${n} വോയ്സ് ചാനലിൽ ചേർന്നു.`, leave: (n) => `${n} വോയ്സ് ചാനലിൽ നിന്ന് പുറത്തുപോയി.` },
  urdu: { join: (n) => `${n} وائس چینل میں شامل ہوئے۔`, leave: (n) => `${n} وائس چینل سے چلے گئے۔` },
  persian: { join: (n) => `${n} به کانال صوتی پیوست.`, leave: (n) => `${n} کانال صوتی را ترک کرد.` },
  czech: { join: (n) => `${n} se připojil k hlasovému kanálu.`, leave: (n) => `${n} opustil hlasový kanál.` },
  hungarian: { join: (n) => `${n} csatlakozott a hangcsatornához.`, leave: (n) => `${n} elhagyta a hangcsatornát.` },
  finnish: { join: (n) => `${n} liittyi äänikanavalle.`, leave: (n) => `${n} poistui äänikanavalta.` },
  danish: { join: (n) => `${n} kom ind i stemmekanalen.`, leave: (n) => `${n} forlod stemmekanalen.` },
  norwegian: { join: (n) => `${n} ble med i talekanalen.`, leave: (n) => `${n} forlot talekanalen.` },
  croatian: { join: (n) => `${n} se pridružio glasovnom kanalu.`, leave: (n) => `${n} je napustio glasovni kanal.` },
  slovak: { join: (n) => `${n} sa pripojil k hlasovému kanálu.`, leave: (n) => `${n} opustil hlasový kanál.` },
  bulgarian: { join: (n) => `${n} се присъедини към гласовия канал.`, leave: (n) => `${n} напусна гласовия канал.` },
  serbian: { join: (n) => `${n} се придружио гласовном каналу.`, leave: (n) => `${n} је напустио гласовни канал.` },
  slovenian: { join: (n) => `${n} se je pridružil glasovnemu kanalu.`, leave: (n) => `${n} je zapustil glasovni kanal.` },
  catalan: { join: (n) => `${n} s'ha unit al canal de veu.`, leave: (n) => `${n} ha sortit del canal de veu.` },
  irish: { join: (n) => `Chuaigh ${n} isteach sa chainéal gutha.`, leave: (n) => `D'fhág ${n} an cainéal gutha.` },
  welsh: { join: (n) => `Ymunodd ${n} â'r sianel lais.`, leave: (n) => `Gadawodd ${n} y sianel lais.` },
  estonian: { join: (n) => `${n} liitus häälkanaliga.`, leave: (n) => `${n} lahkus häälkanalist.` },
  latvian: { join: (n) => `${n} pievienojās balss kanālam.`, leave: (n) => `${n} pameta balss kanālu.` },
  lithuanian: { join: (n) => `${n} prisijungė prie balso kanalo.`, leave: (n) => `${n} paliko balso kanalą.` },
  swahili: { join: (n) => `${n} amejiunga na kituo cha sauti.`, leave: (n) => `${n} ameondoka kwenye kituo cha sauti.` },
  afrikaans: { join: (n) => `${n} het by die stemkanaal aangesluit.`, leave: (n) => `${n} het die stemkanaal verlaat.` },
  amharic: { join: (n) => `${n} የድምጽ ቻናሉን ተቀላቀለ።`, leave: (n) => `${n} ከድምጽ ቻናሉ ወጣ።` },
  yoruba: { join: (n) => `${n} darapọ mọ ikanni ohun.`, leave: (n) => `${n} fi ikanni ohun silẹ.` },
  zulu: { join: (n) => `${n} ujoyine ishaneli yezwi.`, leave: (n) => `${n} ushiye ishaneli yezwi.` },
};

function getLocalizedAnnouncementText(guildId, member, event) {
  const languageKey = getGuildLanguage(guildId, null);
  const template = LOCALIZED_ANNOUNCEMENTS[languageKey] || LOCALIZED_ANNOUNCEMENTS.english;
  const name = humanizeDisplayName(member.displayName || member.user.username, guildId, null);
  return applyHumanPronunciation(template[event](name), guildId, null);
}

function enqueueVoiceAnnouncement(guildId, state, member, event) {
  const settings = getGuildSettings(guildId);
  if (!staffPlatform.isFeatureEnabled("announcements") || !settings.announcements.enabled || !state?.voiceChannelId || isShuttingDown) return;
  if (!member?.user || member.user.bot) return;
  if (staffPlatform.guildRestriction(guildId) || staffPlatform.userRestriction(member.id)) return;

  const speechText = getLocalizedAnnouncementText(guildId, member, event);

  state.queue.push({
    jobId: `announcement:${event}:${member.id}:${Date.now()}`,
    guild: member.guild,
    member,
    userId: member.id,
    voiceChannelId: state.voiceChannelId,
    speechText,
    messageReceivedAt: performance.now(),
    attempts: 0,
    isAnnouncement: true,
    preparedAudioPromise: null,
  });

  if (state.player.state.status === AudioPlayerStatus.Playing) prefetchNextQueuedJob(guildId, state);
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
        // A real VOICE_STATE_UPDATE with channelId=null means Discord has
        // removed this bot user from the VC (for example via the Discord UI).
        // End the session immediately. Network-only/transient failures are
        // still handled by VoiceConnectionStatus.Disconnected and reconnect.
        console.log(
          `[Voice] Bot left/disconnected from VC in guild ${guildId}. Ending TTS session immediately.`
        );
        destroyGuildState(guildId);
        return;
      }

      if (state?.voiceChannelId && newState.channelId !== state.voiceChannelId) {
        console.log(`[Voice] Bot moved to another VC in guild ${guildId}; preserving queued jobs.`);
        state.voiceChannelId = newState.channelId;
        state.lastVoiceChannelId = newState.channelId;
        state.connectedAt = Date.now();
        updateEmptyChannelTimer(guildId);
        void staffPlatform.syncSessions();
      }
      return;
    }

    const autoJoinConfig = getEnabledAutoJoinConfig(guildId);
    if (autoJoinConfig) {
      const enteredAutoJoin =
        oldState.channelId !== autoJoinConfig.channelId &&
        newState.channelId === autoJoinConfig.channelId;
      const leftAutoJoin =
        oldState.channelId === autoJoinConfig.channelId &&
        newState.channelId !== autoJoinConfig.channelId;

      if (enteredAutoJoin) scheduleAutoJoin(guildId);
      if (leftAutoJoin) void cleanupAutoJoinPromptIfEmpty(guildId);
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


client.on(Events.ChannelDelete, (channel) => {
  const guildId = channel.guild?.id;
  if (!guildId) return;

  const config = getEnabledAutoJoinConfig(guildId);
  if (!config || config.channelId !== channel.id) return;

  cancelPendingAutoJoin(guildId);
  void deleteAutoJoinPrompt(guildId);
  void setPersistentAutoJoinConfig(channel.guild, false, null).catch((error) =>
    console.warn(`[Auto-Join] Could not disable deleted configured channel ${channel.id}:`, error?.message || error)
  );
});

client.on(Events.GuildDelete, (guild) => {
  cancelPendingAutoJoin(guild.id);
  void deleteAutoJoinPrompt(guild.id);
  autoJoinRuntime.delete(String(guild.id));
  manualJoinInFlight.delete(String(guild.id));
  autoJoinConfigs.delete(String(guild.id));
  void setPersistentAutoJoinConfig(guild, false, null).catch(() => {});
});


/* =========================================================
   GRACEFUL SHUTDOWN / RAILWAY REDEPLOY
========================================================= */

async function gracefulShutdown(reason = "shutdown") {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Shutdown] Graceful shutdown started (${reason}). Active voice sessions: ${guildStates.size}`);

  for (const guildId of [...guildStates.keys()]) {
    destroyGuildState(guildId);
  }

  staffPlatform.stop();
  // Give Discord a moment to receive voice-state disconnects before closing WS.
  await wait(250).catch(() => {});
  try { client.destroy(); } catch {}
  console.log("[Shutdown] Discord client and all voice sessions closed cleanly.");
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void gracefulShutdown(signal).finally(() => process.exit(0));
  });
}

process.on("message", (message) => {
  if (message?.type === "graceful-shutdown") {
    void gracefulShutdown("shard-manager").finally(() => process.exit(0));
  }
});

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
