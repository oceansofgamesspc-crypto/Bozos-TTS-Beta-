import fs from "node:fs";
import { spawnSync } from "node:child_process";

const GENERATED_MARKER = "/* BOZOS_BETA_HOLOGRAPHIC_VOICE_MODE */";

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first === -1) {
    throw new Error(`[Holographic Beta] Patch anchor not found: ${label}`);
  }
  if (source.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`[Holographic Beta] Patch anchor is ambiguous: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function injectBeforeOnce(source, needle, injection, label) {
  return replaceOnce(source, needle, `${injection}${needle}`, label);
}

export function buildHolographicBetaEntry(sourcePath, outputPath) {
  let source = fs.readFileSync(sourcePath, "utf8");

  if (!source.includes(GENERATED_MARKER)) {
    source = replaceOnce(
      source,
      'import path from "node:path";\n',
      'import path from "node:path";\nimport { spawn } from "node:child_process";\nimport ffmpegPath from "ffmpeg-static";\n',
      "Node imports"
    );

    source = replaceOnce(
      source,
      'const JOIN_SOUND_FILE = path.join(process.cwd(), "bozos-tts-join.mp3");\n',
      'const JOIN_SOUND_FILE = path.join(process.cwd(), "bozos-tts-join.mp3");\n' +
        'const HOLOGRAPHIC_PAN_SLOTS = Object.freeze([0, -0.58, 0.58, -0.30, 0.30, -0.78, 0.78]);\n' +
        'const HOLOGRAPHIC_OPUS_BITRATE = "96k";\n' +
        'let holographicAudioRuntimeAvailable = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));\n',
      "Holographic constants"
    );

    source = replaceOnce(
      source,
      '  volume: 1,\n',
      '  volume: 1,\n  holographicMode: false,\n',
      "Default guild settings"
    );

    source = injectBeforeOnce(
      source,
      '  new SlashCommandBuilder()\n    .setName("skip")\n',
      '  new SlashCommandBuilder()\n' +
        '    .setName("holographic")\n' +
        '    .setDescription("Toggle 3D-like holographic spatial voice for this server")\n' +
        '    .addBooleanOption((option) =>\n' +
        '      option\n' +
        '        .setName("enabled")\n' +
        '        .setDescription("Enable or disable Holographic Voice Mode")\n' +
        '        .setRequired(true)\n' +
        '    ),\n\n',
      "Holographic slash command"
    );

    source = replaceOnce(
      source,
      '      "`/volume` — Set playback volume from 0–200%.\\n" +\n      "" +\n      "`/skip` — Skip the current TTS message.\\n\\n" +',
      '      "`/volume` — Set playback volume from 0–200%.\\n" +\n' +
        '      "`/holographic` — Toggle 3D-like spatial speaker positioning and room reflections.\\n" +\n' +
        '      "`/skip` — Skip the current TTS message.\\n\\n" +',
      "Help command list"
    );

    source = replaceOnce(
      source,
      '    prefetchedJobId: null,\n',
      '    prefetchedJobId: null,\n    holographicSpeakerSlots: new Map(),\n    currentHolographicProcess: null,\n',
      "Guild voice state"
    );

    const holographicHelpers = `${GENERATED_MARKER}\n` + String.raw`
function getHolographicPanForSpeaker(state, userId = null) {
  if (!userId) return 0;
  if (!(state.holographicSpeakerSlots instanceof Map)) {
    state.holographicSpeakerSlots = new Map();
  }
  if (state.holographicSpeakerSlots.has(userId)) {
    return state.holographicSpeakerSlots.get(userId);
  }

  const used = new Set([...state.holographicSpeakerSlots.values()].map((value) => Number(value).toFixed(2)));
  let selected = HOLOGRAPHIC_PAN_SLOTS.find((value) => !used.has(Number(value).toFixed(2)));
  if (selected == null) {
    let hash = 0;
    for (const char of String(userId)) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    selected = HOLOGRAPHIC_PAN_SLOTS[hash % HOLOGRAPHIC_PAN_SLOTS.length];
  }

  state.holographicSpeakerSlots.set(userId, selected);
  return selected;
}

function createHolographicVoiceStream(inputStream, state, userId = null) {
  if (!holographicAudioRuntimeAvailable || !inputStream?.pipe) return null;

  const pan = getHolographicPanForSpeaker(state, userId);
  const leftGain = Math.sqrt((1 - pan) / 2).toFixed(3);
  const rightGain = Math.sqrt((1 + pan) / 2).toFixed(3);
  const lateralDelayMs = Math.max(0, Math.round(Math.abs(pan) * 12));
  const leftDelay = pan > 0 ? lateralDelayMs : 0;
  const rightDelay = pan < 0 ? lateralDelayMs : 0;
  const filter = [
    `pan=stereo|c0=${leftGain}*c0|c1=${rightGain}*c0`,
    `adelay=${leftDelay}|${rightDelay}`,
    "aecho=0.86:0.70:42|86:0.045|0.025",
  ].join(",");

  let ffmpeg;
  try {
    ffmpeg = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "webm",
      "-i", "pipe:0",
      "-vn",
      "-filter:a", filter,
      "-ar", "48000",
      "-ac", "2",
      "-c:a", "libopus",
      "-b:a", HOLOGRAPHIC_OPUS_BITRATE,
      "-vbr", "on",
      "-application", "voip",
      "-f", "ogg",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    holographicAudioRuntimeAvailable = false;
    console.error("[Holographic] FFmpeg could not be started; falling back to normal TTS for this process:", error);
    return null;
  }

  let stderr = "";
  ffmpeg.stderr?.on("data", (chunk) => {
    if (stderr.length < 4000) stderr += chunk.toString();
  });
  ffmpeg.once("error", (error) => {
    holographicAudioRuntimeAvailable = false;
    console.error("[Holographic] FFmpeg runtime failed; Holographic Voice Mode will fall back to normal TTS:", error);
  });
  ffmpeg.once("close", (code, signal) => {
    if (code && signal !== "SIGKILL") {
      holographicAudioRuntimeAvailable = false;
      console.error(`[Holographic] FFmpeg exited with code ${code}. Falling back to normal TTS on future messages.${stderr ? ` ${stderr.trim()}` : ""}`);
    }
  });

  inputStream.once("error", (error) => {
    try { ffmpeg.stdin?.destroy(error); } catch {}
  });
  inputStream.pipe(ffmpeg.stdin);

  return {
    process: ffmpeg,
    sourceStream: inputStream,
    audioStream: ffmpeg.stdout,
    pan,
  };
}

function cleanupHolographicVoiceStream(active) {
  if (!active) return;
  try { active.sourceStream?.unpipe?.(active.process?.stdin); } catch {}
  try { active.process?.stdin?.destroy?.(); } catch {}
  try { active.process?.stdout?.destroy?.(); } catch {}
  try {
    if (active.process && active.process.exitCode == null && !active.process.killed) {
      active.process.kill("SIGKILL");
    }
  } catch {}
}

`;

    source = injectBeforeOnce(
      source,
      '/* =========================================================\n   PLAYBACK\n========================================================= */\n',
      holographicHelpers,
      "Holographic audio helpers"
    );

    source = replaceOnce(
      source,
      '        const settings = getGuildSettings(guildId);\n        const resource = createAudioResource(prepared.audioStream, {\n          inputType: StreamType.WebmOpus,\n          inlineVolume: true,\n          silencePaddingFrames: 1,\n        });\n',
      '        const settings = getGuildSettings(guildId);\n' +
        '        let playbackStream = prepared.audioStream;\n' +
        '        let playbackInputType = StreamType.WebmOpus;\n' +
        '        if (settings.holographicMode) {\n' +
        '          const holographic = createHolographicVoiceStream(\n' +
        '            prepared.audioStream,\n' +
        '            state,\n' +
        '            job.isAnnouncement ? null : job.userId\n' +
        '          );\n' +
        '          if (holographic) {\n' +
        '            state.currentHolographicProcess = holographic;\n' +
        '            playbackStream = holographic.audioStream;\n' +
        '            playbackInputType = StreamType.OggOpus;\n' +
        '            console.log(`[Holographic] Spatial playback • guild ${guildId} • pan ${holographic.pan.toFixed(2)}`);\n' +
        '          }\n' +
        '        }\n' +
        '        const resource = createAudioResource(playbackStream, {\n' +
        '          inputType: playbackInputType,\n' +
        '          inlineVolume: true,\n' +
        '          silencePaddingFrames: 1,\n' +
        '        });\n',
      "TTS playback resource"
    );

    source = replaceOnce(
      source,
      '      } finally {\n        cleanupPreparedAudio(prepared);\n        job.preparedAudioPromise = null;\n',
      '      } finally {\n        cleanupHolographicVoiceStream(state.currentHolographicProcess);\n        state.currentHolographicProcess = null;\n        cleanupPreparedAudio(prepared);\n        job.preparedAudioPromise = null;\n',
      "Queue cleanup"
    );

    source = replaceOnce(
      source,
      '    state.manualDisconnect = true;\n    if (state.reconnectTimer) {\n',
      '    state.manualDisconnect = true;\n    cleanupHolographicVoiceStream(state.currentHolographicProcess);\n    state.currentHolographicProcess = null;\n    if (state.reconnectTimer) {\n',
      "Disconnect cleanup"
    );

    const commandHandler = String.raw`
    /* -----------------------------------------------------
       /HOLOGRAPHIC
    ----------------------------------------------------- */

    if (interaction.commandName === "holographic") {
      const voiceError = requireSameVoiceChannel(interaction);
      if (voiceError) {
        return replyWithV2(interaction, {
          title: "Voice Channel Required",
          description: voiceError,
          color: COLORS.ERROR,
          ephemeral: true,
        });
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return replyWithV2(interaction, {
          title: "Permission Required",
          description: "You need **Manage Server** to change Holographic Voice Mode.",
          color: COLORS.ERROR,
          ephemeral: true,
        });
      }

      const enabled = interaction.options.getBoolean("enabled", true);
      const settings = getGuildSettings(interaction.guildId);
      if (Boolean(settings.holographicMode) === enabled) {
        return replyWithV2(interaction, {
          title: enabled ? "🌀 Holographic Voice Already Enabled" : "Holographic Voice Already Disabled",
          description: enabled
            ? "Holographic Voice Mode is already active for this server."
            : "Holographic Voice Mode is already disabled for this server.",
          color: COLORS.WARNING,
          ephemeral: true,
        });
      }

      settings.holographicMode = enabled;
      return replyWithV2(interaction, {
        title: enabled ? "🌀 Holographic Voice Enabled" : "Holographic Voice Disabled",
        description: enabled
          ? "Bozos will now place speakers on a stable 3D-like stereo stage with subtle left/right timing cues and room reflections. The change starts with the next spoken message. **Headphones are strongly recommended.**"
          : "Bozos has returned to the normal mono TTS playback path. The current message, if any, is left untouched.",
        color: COLORS.SUCCESS,
      });
    }

`;

    source = injectBeforeOnce(
      source,
      '    /* -----------------------------------------------------\n       /SKIP\n    ----------------------------------------------------- */\n',
      commandHandler,
      "Holographic command handler"
    );
  }

  fs.writeFileSync(outputPath, source, "utf8");

  const syntax = spawnSync(process.execPath, ["--check", outputPath], {
    encoding: "utf8",
  });
  if (syntax.status !== 0) {
    try { fs.unlinkSync(outputPath); } catch {}
    throw new Error(`[Holographic Beta] Generated index failed syntax validation:\n${syntax.stderr || syntax.stdout}`);
  }

  console.log("[Holographic Beta] Generated and syntax-validated the Holographic Voice Mode shard entry.");
  return outputPath;
}
