/**
 * Catalog of MCP servers LocalHarness knows how to run.
 *
 * These mirror the servers already installed under ~/.config/*-mcp. The
 * `estimatedTokens` figures are the measured cost of each server's tools/list
 * output; they seed the payload-budget readout before a server has been started,
 * and are replaced with a real count once tools are discovered.
 *
 * Timeouts are load-bearing. The MCP SDK's default request timeout is 60s,
 * which is shorter than a single image render — a too-low timeout looks like a
 * broken server rather than a slow one.
 */

import type { McpServerSpec } from './types'

const HOME = '~'
const PY = '/usr/bin/python3'

export const MCP_REGISTRY: McpServerSpec[] = [
  {
    id: 'websearch',
    label: 'Web search',
    blurb: 'Search the web and fetch page text.',
    command: PY,
    args: [`${HOME}/.config/websearch-mcp/server.py`],
    env: { WEBSEARCH_MIN_INTERVAL: '1.0' },
    callTimeoutMs: 120_000,
    estimatedTokens: 258,
    autoStart: true
  },
  {
    id: 'fastfacts',
    label: 'Fast facts',
    blurb: 'Weather, scores, news and drive times without a search round-trip.',
    command: PY,
    args: [`${HOME}/.config/fastfacts-mcp/server.py`],
    env: {
      FASTFACTS_HOME: 'Upper East Side, New York',
      FASTFACTS_TIMEOUT: '8'
    },
    callTimeoutMs: 30_000,
    estimatedTokens: 516,
    autoStart: true
  },
  {
    id: 'comfy-image',
    label: 'Image generation',
    blurb: 'ComfyUI text-to-image and image editing.',
    command: PY,
    args: [`${HOME}/.config/comfy-mcp/server.py`],
    env: {
      COMFY_HOST: 'http://127.0.0.1:8188',
      COMFY_AUTOSTART: '1',
      COMFY_GEN_TIMEOUT: '900'
    },
    // A cold render can take the full COMFY_GEN_TIMEOUT plus model load.
    callTimeoutMs: 960_000,
    estimatedTokens: 3007,
    autoStart: false
  },
  {
    id: 'comfy-audio',
    label: 'Audio generation',
    blurb: 'ComfyUI music and sound effect generation.',
    command: PY,
    args: [`${HOME}/.config/comfy-audio/server.py`],
    env: {
      COMFY_HOST: 'http://127.0.0.1:8188',
      AUDIO_AUTOSTART: '1',
      AUDIO_GEN_TIMEOUT: '1800'
    },
    callTimeoutMs: 1_860_000,
    estimatedTokens: 859,
    autoStart: false
  },
  {
    id: 'voice',
    label: 'Voice',
    blurb: 'Local text-to-speech and transcription.',
    command: `${HOME}/.config/voice-mcp/venv/bin/python`,
    args: [`${HOME}/.config/voice-mcp/server.py`],
    env: {
      VOICE_OUTPUT_DIR: `${HOME}/Documents/llm-audio`,
      VOICE_FORMAT: 'mp3'
    },
    callTimeoutMs: 300_000,
    estimatedTokens: 562,
    autoStart: false
  },
  {
    id: 'docgen',
    label: 'Documents',
    blurb: 'Generate PDF, Word, PowerPoint and Excel files.',
    command: `${HOME}/.config/docgen-mcp/venv/bin/python`,
    args: [`${HOME}/.config/docgen-mcp/server.py`],
    env: {
      DOCGEN_OUTPUT_DIR: `${HOME}/Documents/llm-docs`,
      DOCGEN_OPEN: '0'
    },
    callTimeoutMs: 300_000,
    estimatedTokens: 624,
    autoStart: false
  },
  {
    id: 'data',
    label: 'Data',
    blurb: 'DuckDB over local CSV, Excel and Parquet files.',
    command: `${HOME}/.config/data-mcp/venv/bin/python`,
    args: [`${HOME}/.config/data-mcp/server.py`],
    env: {
      DATA_OUTPUT_DIR: `${HOME}/Documents/llm-data`,
      DATA_MAX_ROWS: '50'
    },
    callTimeoutMs: 300_000,
    estimatedTokens: 428,
    autoStart: false
  },
  {
    id: 'playwright',
    label: 'Browser',
    blurb: 'Drive and screenshot a real browser.',
    command: `${HOME}/.config/playwright-mcp/venv/bin/python`,
    args: [`${HOME}/.config/playwright-mcp/server.py`],
    env: {
      PWMCP_PORT: '9333',
      PWMCP_DSF: '2',
      PWMCP_VISION_MAX_PX: '1024'
    },
    callTimeoutMs: 300_000,
    estimatedTokens: 839,
    autoStart: false
  },
  {
    id: 'ui-review',
    label: 'UI review',
    blurb: 'Measure and critique a rendered page.',
    command: PY,
    args: [`${HOME}/.config/ui-review-mcp/server.py`],
    env: { UIREVIEW_PORT: '9333', UIREVIEW_DSF: '2' },
    callTimeoutMs: 300_000,
    estimatedTokens: 806,
    autoStart: false
  },
  {
    id: 'gmail',
    label: 'Gmail',
    blurb: 'Read and search Adam\'s mail.',
    // A node CLI on the Homebrew path, not a Python server like the others.
    // Reached through augmentedPath(), since a Finder-launched app does not
    // inherit /opt/homebrew/bin.
    command: 'gmail-mcp',
    args: [],
    env: {},
    callTimeoutMs: 120_000,
    // Unmeasured — the registry figure is a placeholder until the server has
    // reported its tools, at which point the panel shows the real count.
    estimatedTokens: 900,
    autoStart: false
  },
  {
    id: 'webassets',
    label: 'Web assets',
    blurb: 'Real SVG icons and responsive WebP/AVIF image sets.',
    command: `${HOME}/.config/webassets-mcp/venv/bin/python`,
    args: [`${HOME}/.config/webassets-mcp/server.py`],
    env: { WEBASSETS_OUTPUT_DIR: `${HOME}/Documents/llm-web` },
    callTimeoutMs: 300_000,
    estimatedTokens: 547,
    autoStart: false
  }
]

export const MCP_BY_ID: Record<string, McpServerSpec> = Object.fromEntries(
  MCP_REGISTRY.map((s) => [s.id, s])
)
