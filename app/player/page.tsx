"use client";

/* eslint-disable @next/next/no-img-element -- live artwork can be a MediaRemote data URL or a remote catalog URL. */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  advanceCircularKnobGesture,
  createCircularKnobGesture,
  volumeToKnobAngle,
} from "./volume-gesture.mjs";
import {
  liveTrackIdentity,
  shouldHoldIncomingTrack,
  transientIdleGracePeriod,
} from "./live-track-transition.mjs";

type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  artwork: string;
  accent: string;
  accentSoft: string;
  audio?: string;
};

type PlayerProps = {
  demoMode?: "app" | "landing";
};

type PlayerSource = "spotify" | "apple-music" | "browser" | "youtube-music";

type NowPlayingResponse = {
  status: "playing" | "paused" | "idle" | "error";
  source?: PlayerSource;
  player?: string;
  reason?: string;
  message?: string;
  track?: {
    title: string;
    artist: string;
    album: string;
    duration: number;
    position: number;
    volume: number;
    artwork: string;
    artworkPending?: boolean;
  };
};

type NeedleDesktopBridge = {
  platform: "macos";
  mode: "controls" | "wallpaper";
  getNowPlaying(): Promise<NowPlayingResponse>;
  onNowPlaying(callback: (payload: NowPlayingResponse) => void): void;
  offNowPlaying(): void;
  setVolume(source: PlayerSource, volume: number): Promise<{ source: PlayerSource; volume: number }>;
  setPlayback(source: PlayerSource, playing: boolean): Promise<{ source: PlayerSource; playing: boolean }>;
};

declare global {
  interface Window {
    needleDesktop?: NeedleDesktopBridge;
  }
}

const COMPANION_URL = "http://127.0.0.1:43117/now-playing";
const VOLUME_URL = "http://127.0.0.1:43117/volume";
const PLAYBACK_URL = "http://127.0.0.1:43117/playback";
const TONEARM_REST_ANGLE = -16;
const TONEARM_PLAY_ANGLE = 7;
const TONEARM_PLAY_THRESHOLD = -4.5;
const KNOB_SOUNDS = [
  "/audio/knob/gear-q1.mp3",
  "/audio/knob/gear-q2.mp3",
  "/audio/knob/gear-q3.mp3",
  "/audio/knob/gear-q4.mp3",
];

const TRACKS: Track[] = [
  {
    id: "nocturne-lines",
    title: "Slow Orbit",
    artist: "Mira Vale",
    album: "Nocturne Lines",
    duration: 258,
    artwork: "/artwork/nocturne-lines.webp",
    accent: "#ee5735",
    accentSoft: "#315fd0",
  },
  {
    id: "warm-static",
    title: "Soft Receiver",
    artist: "Hosh",
    album: "Warm Static",
    duration: 221,
    artwork: "/artwork/warm-static.webp",
    accent: "#e87546",
    accentSoft: "#dca08c",
  },
  {
    id: "glass-gardens",
    title: "After the Rain",
    artist: "Sora",
    album: "Glass Gardens",
    duration: 286,
    artwork: "/artwork/glass-gardens.webp",
    accent: "#a99ed4",
    accentSoft: "#79b8a9",
  },
];

const LANDING_TRACKS: Track[] = [
  {
    id: "slow-orbit-open-source-demo",
    title: "Slow Orbit",
    artist: "Needle Studio",
    album: "Open Source Sessions",
    duration: 24,
    artwork: "/artwork/nocturne-lines.webp",
    audio: "/audio/needle-demo.m4a",
    accent: "#ee5735",
    accentSoft: "#315fd0",
  },
];

function formatTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export default function Home({ demoMode = "app" }: PlayerProps = {}) {
  const isLandingDemo = demoMode === "landing";
  const demoTracks = isLandingDemo ? LANDING_TRACKS : TRACKS;
  const [trackIndex, setTrackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(!isLandingDemo);
  const [progress, setProgress] = useState(isLandingDemo ? 0 : 42);
  const [liveTrack, setLiveTrack] = useState<Track | null>(null);
  const liveTrackRef = useRef<Track | null>(null);
  const [playerName, setPlayerName] = useState("");
  const [liveSource, setLiveSource] = useState<PlayerSource | null>(null);
  const [volume, setVolume] = useState(72);
  const [isAdjustingVolume, setIsAdjustingVolume] = useState(false);
  const [isAdjustingTonearm, setIsAdjustingTonearm] = useState(false);
  const sceneRef = useRef<HTMLElement>(null);
  const tonearmGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startAngle: number;
    latestAngle: number;
    moved: boolean;
  } | null>(null);
  const volumeGestureRef = useRef<{
    pointerId: number;
    centerX: number;
    centerY: number;
    deadZoneRadius: number;
    lastPointerAngle: number;
    knobAngle: number;
    latestVolume: number;
    inDeadZone: boolean;
  } | null>(null);
  const volumeSyncTimerRef = useRef<number | undefined>(undefined);
  const pendingVolumeRef = useRef(volume);
  const isAdjustingVolumeRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const demoAudioRef = useRef<HTMLAudioElement | null>(null);
  const knobSoundTemplatesRef = useRef<HTMLAudioElement[]>([]);
  const activeKnobSoundsRef = useRef<Set<HTMLAudioElement>>(new Set());
  const lastTickRef = useRef(Math.round(volume / 4));

  const track = liveTrack ?? demoTracks[trackIndex];
  const isLive = liveTrack !== null;

  const selectTrack = useCallback((index: number) => {
    setTrackIndex((index + demoTracks.length) % demoTracks.length);
    setProgress(0);
    setIsPlaying(true);
  }, [demoTracks]);

  const nextTrack = useCallback(() => {
    selectTrack(trackIndex + 1);
  }, [selectTrack, trackIndex]);

  const previousTrack = useCallback(() => {
    selectTrack(trackIndex - 1);
  }, [selectTrack, trackIndex]);

  const applyPlayback = useCallback((playing: boolean) => {
    if (playing === isPlaying) return;

    const previousState = isPlaying;
    setIsPlaying(playing);

    if (isLandingDemo) {
      const audio = demoAudioRef.current;
      if (!audio) return;
      if (playing) {
        void audio.play().catch(() => setIsPlaying(false));
      } else {
        audio.pause();
      }
      return;
    }

    if (!liveSource) return;

    const updateLivePlayer = async () => {
      try {
        if (window.needleDesktop) {
          await window.needleDesktop.setPlayback(liveSource, playing);
          return;
        }

        const response = await fetch(PLAYBACK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: liveSource, playing }),
        });
        if (!response.ok) throw new Error("Playback request failed");
      } catch {
        setIsPlaying(previousState);
      }
    };

    void updateLivePlayer();
  }, [isLandingDemo, isPlaying, liveSource]);

  const playKnobTick = useCallback((nextVolume: number) => {
    const playSynthesizedFallback = () => {
      const AudioContextConstructor = window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextConstructor) return;

      const context = audioContextRef.current ?? new AudioContextConstructor();
      audioContextRef.current = context;
      if (context.state === "suspended") void context.resume();

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(520 + nextVolume * 1.6, now);
      oscillator.frequency.exponentialRampToValueAtTime(160, now + 0.021);
      gain.gain.setValueAtTime(0.014, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.024);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.026);
    };

    const detent = Math.abs(Math.round(nextVolume / 4));
    const template = knobSoundTemplatesRef.current[detent % KNOB_SOUNDS.length];
    if (!template) {
      playSynthesizedFallback();
      return;
    }

    const sound = template.cloneNode(true) as HTMLAudioElement;
    sound.volume = 0.55;
    const activeSounds = activeKnobSoundsRef.current;
    const releaseSound = () => activeSounds.delete(sound);
    activeSounds.add(sound);
    sound.addEventListener("ended", releaseSound, { once: true });
    sound.addEventListener("error", releaseSound, { once: true });
    void sound.play().catch(() => {
      releaseSound();
      playSynthesizedFallback();
    });
  }, []);

  const sendVolume = useCallback(async (nextVolume: number) => {
    if (!liveSource) return;
    try {
      if (window.needleDesktop) {
        await window.needleDesktop.setVolume(liveSource, Math.round(nextVolume));
        return;
      }

      const response = await fetch(VOLUME_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: liveSource, volume: Math.round(nextVolume) }),
      });
      if (!response.ok) throw new Error("Volume request failed");
    } catch {
      // Keep the local knob responsive if a player rejects the volume request.
    }
  }, [liveSource]);

  const queueVolumeSync = useCallback((nextVolume: number, immediate = false) => {
    pendingVolumeRef.current = nextVolume;
    if (immediate) {
      if (volumeSyncTimerRef.current) window.clearTimeout(volumeSyncTimerRef.current);
      volumeSyncTimerRef.current = undefined;
      void sendVolume(nextVolume);
      return;
    }

    if (volumeSyncTimerRef.current) return;
    volumeSyncTimerRef.current = window.setTimeout(() => {
      volumeSyncTimerRef.current = undefined;
      void sendVolume(pendingVolumeRef.current);
    }, 80);
  }, [sendVolume]);

  const applyVolume = useCallback((requestedVolume: number, immediate = false) => {
    const nextVolume = Math.max(0, Math.min(100, Math.round(requestedVolume)));
    setVolume(nextVolume);
    const nextTick = Math.round(nextVolume / 4);
    if (nextTick !== lastTickRef.current) {
      lastTickRef.current = nextTick;
      playKnobTick(nextVolume);
    }
    queueVolumeSync(nextVolume, immediate);
    if (volumeGestureRef.current) volumeGestureRef.current.latestVolume = nextVolume;
  }, [playKnobTick, queueVolumeSync]);

  useEffect(() => {
    if (isLandingDemo) return;

    let cancelled = false;
    let timer: number | undefined;
    let idleTimer: number | undefined;

    const clearLivePlayback = () => {
      idleTimer = undefined;
      if (cancelled) return;
      liveTrackRef.current = null;
      setLiveTrack(null);
      setPlayerName("");
      setLiveSource(null);
    };

    const scheduleLivePlaybackClear = () => {
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(clearLivePlayback, transientIdleGracePeriod);
    };

    const applyNowPlaying = (payload: NowPlayingResponse) => {
      if (cancelled) return;

      if ((payload.status === "playing" || payload.status === "paused") && payload.track) {
        if (idleTimer) {
          window.clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        const nextTrackIdentity = liveTrackIdentity(payload.source, payload.track.title);
        if (shouldHoldIncomingTrack(
          liveTrackRef.current?.id,
          nextTrackIdentity,
          payload.track.artworkPending,
        )) {
          return;
        }
        const sourceLabel = payload.source === "spotify"
          ? "Spotify"
          : payload.source === "browser"
            ? payload.player || "Web Browser"
            : payload.source === "youtube-music"
            ? "YouTube Music"
            : "Apple Music";
        const sourceAccent = payload.source === "spotify"
          ? ["#45c979", "#1f8050"]
          : payload.source === "browser"
            ? ["#5f83ff", "#34487d"]
            : payload.source === "youtube-music"
            ? ["#ff3355", "#891f35"]
            : ["#fa586a", "#8f4360"];
        const nextTrack = {
          id: nextTrackIdentity,
          title: payload.track.title,
          artist: payload.track.artist,
          album: payload.track.album,
          duration: payload.track.duration,
          artwork: payload.track.artwork || "/artwork/warm-static.webp",
          accent: sourceAccent[0],
          accentSoft: sourceAccent[1],
        };
        liveTrackRef.current = nextTrack;
        setLiveTrack(nextTrack);
        setProgress(Math.min(payload.track.position, payload.track.duration));
        if (!isAdjustingVolumeRef.current) {
          const reportedVolume = Number(payload.track.volume);
          if (Number.isFinite(reportedVolume)) {
            const syncedVolume = Math.max(0, Math.min(100, reportedVolume));
            setVolume(syncedVolume);
            pendingVolumeRef.current = syncedVolume;
            lastTickRef.current = Math.round(syncedVolume / 4);
          }
        }
        setIsPlaying(payload.status === "playing");
        setPlayerName(sourceLabel);
        setLiveSource(payload.source ?? null);
      } else {
        scheduleLivePlaybackClear();
      }
    };

    const syncNowPlaying = async () => {
      try {
        let payload: NowPlayingResponse;
        if (window.needleDesktop) {
          payload = await window.needleDesktop.getNowPlaying();
        } else {
          const response = await fetch(COMPANION_URL, { cache: "no-store" });
          if (!response.ok) throw new Error(`Companion returned ${response.status}`);
          payload = await response.json() as NowPlayingResponse;
        }
        applyNowPlaying(payload);
      } catch {
        if (cancelled) return;
        scheduleLivePlaybackClear();
      } finally {
        const fallbackInterval = window.needleDesktop ? 30_000 : 2000;
        if (!cancelled) timer = window.setTimeout(syncNowPlaying, fallbackInterval);
      }
    };

    window.needleDesktop?.onNowPlaying(applyNowPlaying);
    void syncNowPlaying();
    return () => {
      cancelled = true;
      window.needleDesktop?.offNowPlaying();
      if (timer) window.clearTimeout(timer);
      if (idleTimer) window.clearTimeout(idleTimer);
    };
  }, [isLandingDemo]);

  useEffect(() => {
    const audio = demoAudioRef.current;
    if (!isLandingDemo || !audio) return;
    audio.volume = volume / 100;
  }, [isLandingDemo, volume]);

  useEffect(() => () => {
    if (volumeSyncTimerRef.current) window.clearTimeout(volumeSyncTimerRef.current);
    if (audioContextRef.current) void audioContextRef.current.close();
  }, []);

  useEffect(() => {
    const activeSounds = activeKnobSoundsRef.current;
    const templates = KNOB_SOUNDS.map((src) => {
      const sound = new Audio(src);
      sound.preload = "auto";
      sound.load();
      return sound;
    });
    knobSoundTemplatesRef.current = templates;

    return () => {
      knobSoundTemplatesRef.current = [];
      activeSounds.forEach((sound) => sound.pause());
      activeSounds.clear();
      templates.forEach((sound) => sound.pause());
    };
  }, []);

  useEffect(() => {
    if (!isPlaying || isLandingDemo) return;

    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (!isLive && current + 0.25 >= track.duration) {
          window.setTimeout(nextTrack, 0);
          return 0;
        }
        return Math.min(current + 0.25, track.duration);
      });
    }, 250);

    return () => window.clearInterval(timer);
  }, [isLandingDemo, isLive, isPlaying, nextTrack, track.duration]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "BUTTON") return;

      if (event.code === "Space") {
        event.preventDefault();
        applyPlayback(!isPlaying);
      }
      if (!isLive && !isLandingDemo && event.code === "ArrowRight") nextTrack();
      if (!isLive && !isLandingDemo && event.code === "ArrowLeft") previousTrack();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyPlayback, isLandingDemo, isLive, isPlaying, nextTrack, previousTrack]);

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const rect = scene.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    scene.style.setProperty("--pointer-x", x.toFixed(3));
    scene.style.setProperty("--pointer-y", y.toFixed(3));
  };

  const beginTonearmDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startAngle = isPlaying ? TONEARM_PLAY_ANGLE : TONEARM_REST_ANGLE;
    event.currentTarget.style.setProperty("--tonearm-angle", `${startAngle}deg`);
    tonearmGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startAngle,
      latestAngle: startAngle,
      moved: false,
    };
    setIsAdjustingTonearm(true);
  };

  const moveTonearmDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = tonearmGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();

    const movement = gesture.startX - event.clientX;
    const nextAngle = Math.max(
      TONEARM_REST_ANGLE,
      Math.min(TONEARM_PLAY_ANGLE, gesture.startAngle + movement * 0.18),
    );
    gesture.latestAngle = nextAngle;
    if (Math.abs(movement) > 4) gesture.moved = true;
    event.currentTarget.style.setProperty("--tonearm-angle", `${nextAngle}deg`);
  };

  const finishTonearmGesture = (
    event: React.PointerEvent<HTMLDivElement>,
    commit: boolean,
  ) => {
    const gesture = tonearmGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const shouldPlay = commit
      ? gesture.moved
        ? gesture.latestAngle >= TONEARM_PLAY_THRESHOLD
        : !isPlaying
      : isPlaying;
    const targetAngle = shouldPlay ? TONEARM_PLAY_ANGLE : TONEARM_REST_ANGLE;
    event.currentTarget.style.setProperty("--tonearm-angle", `${targetAngle}deg`);
    tonearmGestureRef.current = null;
    setIsAdjustingTonearm(false);
    applyPlayback(shouldPlay);

    const tonearm = event.currentTarget;
    window.requestAnimationFrame(() => tonearm.style.removeProperty("--tonearm-angle"));
  };

  const handleTonearmKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    applyPlayback(!isPlaying);
  };

  const beginVolumeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    volumeGestureRef.current = createCircularKnobGesture({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      deadZoneRadius: Math.max(9, Math.min(rect.width, rect.height) * 0.22),
      volume,
    });
    isAdjustingVolumeRef.current = true;
    setIsAdjustingVolume(true);
  };

  const moveVolumeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = volumeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = advanceCircularKnobGesture(gesture, event.clientX, event.clientY);
    volumeGestureRef.current = next.gesture;
    if (next.volume !== null) applyVolume(next.volume);
  };

  const endVolumeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = volumeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    volumeGestureRef.current = null;
    isAdjustingVolumeRef.current = false;
    setIsAdjustingVolume(false);
    queueVolumeSync(gesture.latestVolume, true);
  };

  const handleVolumeWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    applyVolume(volume + (event.deltaY < 0 ? 3 : -3), true);
  };

  const handleVolumeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextVolume = volume;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") nextVolume += 2;
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") nextVolume -= 2;
    else if (event.key === "PageUp") nextVolume += 10;
    else if (event.key === "PageDown") nextVolume -= 10;
    else if (event.key === "Home") nextVolume = 0;
    else if (event.key === "End") nextVolume = 100;
    else return;
    event.preventDefault();
    event.stopPropagation();
    applyVolume(nextVolume, true);
  };

  const style = {
    "--accent": track.accent,
    "--accent-soft": track.accentSoft,
  } as React.CSSProperties;

  return (
    <main
      ref={sceneRef}
      className={`app-shell ${isLandingDemo ? "is-landing-demo" : ""}`}
      style={style}
      onPointerMove={handlePointerMove}
    >
      <div className="titlebar-drag-region" aria-hidden="true" />
      {isLandingDemo && track.audio ? (
        // Music-only demo; there is no spoken content to caption.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio
          ref={demoAudioRef}
          src={track.audio}
          preload="metadata"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={(event) => setProgress(event.currentTarget.currentTime)}
          onEnded={() => {
            setProgress(track.duration);
            setIsPlaying(false);
          }}
        />
      ) : null}
      <div className="room-light" aria-hidden="true" />
      <div className="window-shadow" aria-hidden="true" />

      <section id="player" className="listening-stage" aria-label="Interactive turntable">
        <div className="table-reflection" aria-hidden="true" />

        <div className="sleeve-wrap" key={`sleeve-${track.id}`}>
          <div className="sleeve-shadow" />
          <div className="sleeve">
            <img src={track.artwork} alt={`${track.album} cover artwork`} />
            <div className="paper-sheen" />
          </div>
        </div>

        <div className="turntable">
          <div className="plinth-edge" />
          <div className="platter-shadow" />
          <div className="platter">
            <div className={`record ${isPlaying ? "spinning" : ""}`}>
              <div className="record-grooves" />
              <div className="record-shine" />
              <div className="record-label" key={`label-${track.id}`}>
                <img src={track.artwork} alt="" />
                <span className="spindle" />
              </div>
            </div>
          </div>

          <div
            className={`tonearm ${isPlaying ? "on-record" : ""} ${isAdjustingTonearm ? "is-adjusting" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={isPlaying ? "Lift tonearm to pause" : "Place tonearm on the record to play"}
            aria-pressed={isPlaying}
            title={isPlaying ? "Drag the tonearm away to pause" : "Drag the tonearm onto the record to play"}
            onPointerDown={beginTonearmDrag}
            onPointerMove={moveTonearmDrag}
            onPointerUp={(event) => finishTonearmGesture(event, true)}
            onPointerCancel={(event) => finishTonearmGesture(event, false)}
            onKeyDown={handleTonearmKeyDown}
          >
            <div className="tonearm-pivot"><span /></div>
            <div className="tonearm-tube" />
            <div className="headshell"><i /><i /><i /><i /></div>
          </div>

          <div className={`volume-control ${isAdjustingVolume ? "is-adjusting" : ""}`}>
            <span className="volume-readout" aria-hidden="true">{Math.round(volume)}</span>
            <div
              className="volume-knob"
              role="slider"
              tabIndex={0}
              aria-label={`${playerName || "Demo"} volume`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(volume)}
              aria-valuetext={`${Math.round(volume)} percent`}
              title={isLive
                ? "Rotate around the knob, scroll, or use arrow keys"
                : "Rotate around the knob for a tactile preview; it controls volume when music plays"}
              onPointerDown={beginVolumeDrag}
              onPointerMove={moveVolumeDrag}
              onPointerUp={endVolumeDrag}
              onPointerCancel={endVolumeDrag}
              onWheel={handleVolumeWheel}
              onKeyDown={handleVolumeKeyDown}
              style={{
                "--knob-angle": `${volumeToKnobAngle(volume)}deg`,
                "--volume-sweep": `${volume * .75}%`,
              } as React.CSSProperties}
            >
              <span className="volume-arc" aria-hidden="true" />
              <span className="knob-cap" aria-hidden="true"><i /></span>
            </div>
            <span className="volume-label" aria-hidden="true">Volume</span>
          </div>

          <div className="power-light" />
          <div className="maker-plate">NEEDLE / 01</div>
        </div>
      </section>

      <section className="transport" aria-label="Playback controls">
        <div className="transport-meta">
          <img src={track.artwork} alt="" />
          <div>
            <strong>{track.title}</strong>
            <span>{track.artist}</span>
          </div>
        </div>

        <div className="transport-center">
          <div className="control-buttons">
            <button type="button" onClick={previousTrack} aria-label="Previous track" disabled={isLive || isLandingDemo}>‹</button>
            <button
              className="play-button"
              type="button"
              onClick={() => applyPlayback(!isPlaying)}
              aria-label={isPlaying ? "Pause" : "Play"}
              aria-pressed={isPlaying}
            >
              {isPlaying ? <span className="pause-icon" /> : <span className="play-icon" />}
            </button>
            <button type="button" onClick={nextTrack} aria-label="Next track" disabled={isLive || isLandingDemo}>›</button>
          </div>

          <div className="timeline">
            <span>{formatTime(progress)}</span>
            <input
              type="range"
              min="0"
              max={track.duration}
              step="0.1"
              value={Math.min(progress, track.duration)}
              onChange={(event) => {
                const nextProgress = Number(event.target.value);
                setProgress(nextProgress);
                if (isLandingDemo && demoAudioRef.current) {
                  demoAudioRef.current.currentTime = nextProgress;
                }
              }}
              aria-label="Track progress"
              disabled={isLive}
              style={{ "--progress": `${(progress / track.duration) * 100}%` } as React.CSSProperties}
            />
            <span>-{formatTime(track.duration - progress)}</span>
          </div>
        </div>
      </section>
    </main>
  );
}
