// free-model-aggregator-01 entry: one server, two client wires, ten free-tier providers.
//
// The server reads the trial brief ($MAKEFUN_PROMPT_FILE), probes every provider's
// catalog route in that provider's own wire, and registers one catalog with the env.
// For each of the 20 client requests it picks the highest-rated free model that meets
// the request's requirements, speaks that provider's wire (OpenAI, Anthropic or
// Gemini), translates the answer back into the wire the client used, and fails over
// to the next-best model when a provider refuses (402/429/5xx). A provider that
// reports its budget spent, or an outage, is never dialled again in the trial.
//
// Routing is a pure function of the brief and the provider answers seen so far: no
// wall clock and no unseeded randomness anywhere, so a replay leaves the same
// state. Node 22 standard library only; run as `node main.ts`, or
// `node main.ts --list` to print the catalog document and exit.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

const PROTOCOL_VERSION = 1;
const POLL_MS = 100;
const PROBE_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const FIXED_CREATED = 1767225600;
const FIXED_CREATED_AT = '2026-01-01T00:00:00Z';
const ANTHROPIC_VERSION = '2023-06-01';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const strOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function log(msg: string): void {
  process.stderr.write(`aggregator: ${msg}\n`);
}

export type Wire = 'openai' | 'anthropic' | 'gemini';
export type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

export interface ProviderEntry {
  id: string;
  name: string;
  wire: Wire;
  auth: AuthScheme;
  base: string;
  key_env: string;
  key: string;
}

export interface RatingRow {
  model: string;
  provider: string;
  rating: number;
  context: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

export interface ManifestRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

export interface Brief {
  providers: ProviderEntry[];
  ratings: RatingRow[];
  best: Map<string, number>;
  manifest: ManifestRow[];
  error: string | null;
}

export interface ProbedModel {
  id: string;
  display: string;
  free: boolean | null;
  context: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

export interface Probe {
  provider: ProviderEntry;
  ok: boolean;
  models: ProbedModel[];
}

export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: CatalogModel[];
}

export interface Catalog {
  providers: CatalogProvider[];
}

/** The index of the `}` closing the object that opens at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every JSON object in `text` carrying a string `schema`, in order of appearance. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not JSON on its own: keep scanning.
    }
  }
  return out;
}

function parseProvider(v: unknown): ProviderEntry | null {
  if (!isRecord(v)) return null;
  const id = strOf(v.id);
  const wire = v.wire === 'openai' || v.wire === 'anthropic' || v.wire === 'gemini' ? v.wire : null;
  if (id === '' || wire === null) return null;
  const auth = v.auth === 'bearer' || v.auth === 'x-api-key' || v.auth === 'x-goog-api-key' || v.auth === 'none' ? v.auth : 'bearer';
  const base = strOf(v.path) !== '' ? strOf(v.path) : strOf(v.base_path) !== '' ? strOf(v.base_path) : strOf(v.base_url) !== '' ? strOf(v.base_url) : strOf(v.base);
  return { id, name: strOf(v.name) !== '' ? strOf(v.name) : id, wire, auth, base, key_env: strOf(v.key_env), key: strOf(v.key) };
}

function parseRating(v: unknown): RatingRow | null {
  if (!isRecord(v)) return null;
  const model = strOf(v.model);
  const provider = strOf(v.provider);
  if (model === '' || provider === '') return null;
  return {
    model,
    provider,
    rating: typeof v.rating_milli === 'number' && Number.isFinite(v.rating_milli) ? v.rating_milli : 0,
    context: numOrNull(v.context_length),
    tools: v.tools === true,
    vision: v.vision === true,
    json: v.json === true,
    free: v.free === true,
  };
}

/** Read the brief: provider directory, quality table and workload manifest. */
export function readBrief(path: string): Brief {
  const empty: Brief = { providers: [], ratings: [], best: new Map(), manifest: [], error: null };
  if (path === '') return { ...empty, error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ...empty, error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const dirDoc = docs.find((d) => d.schema === 'free-model-aggregator-01/providers/v1' && Array.isArray(d.providers)) ?? null;
  if (dirDoc === null || !Array.isArray(dirDoc.providers)) {
    return { ...empty, error: 'the brief holds no provider directory' };
  }
  const providers = dirDoc.providers.flatMap((v) => {
    const p = parseProvider(v);
    return p === null ? [] : [p];
  });
  const ratingsDoc = docs.find((d) => d.schema === 'free-model-aggregator-01/ratings/v1' && Array.isArray(d.ratings)) ?? null;
  const ratings: RatingRow[] =
    ratingsDoc === null || !Array.isArray(ratingsDoc.ratings)
      ? []
      : ratingsDoc.ratings.flatMap((v) => {
          const r = parseRating(v);
          return r === null ? [] : [r];
        });
  const best = new Map<string, number>();
  if (ratingsDoc !== null && Array.isArray(ratingsDoc.best)) {
    for (const v of ratingsDoc.best) {
      if (isRecord(v) && strOf(v.id) !== '') best.set(strOf(v.id), numOrNull(v.rating_milli) ?? 0);
    }
  }
  const workDoc = docs.find((d) => d.schema === 'free-model-aggregator-01/workload/v1' && Array.isArray(d.manifest)) ?? null;
  const manifest: ManifestRow[] =
    workDoc === null || !Array.isArray(workDoc.manifest)
      ? []
      : workDoc.manifest.flatMap((v): ManifestRow[] => {
          if (!isRecord(v) || strOf(v.id) === '') return [];
          const req = isRecord(v.requires) ? v.requires : {};
          return [
            {
              id: strOf(v.id),
              api: v.api === 'anthropic' ? 'anthropic' : 'openai',
              stream: v.stream === true,
              weight: v.weight === 2 ? 2 : 1,
              requires: {
                ...(req.tools === true ? { tools: true } : {}),
                ...(req.vision === true ? { vision: true } : {}),
                ...(req.json === true ? { json: true } : {}),
                ...(typeof req.min_context === 'number' && Number.isFinite(req.min_context) ? { min_context: req.min_context } : {}),
              },
            },
          ];
        });
  return { providers, ratings, best, manifest, error: null };
}

/** Join a provider base (a path like /p/groq, or an absolute URL) to the env origin. */
export function joinBase(envUrl: string, base: string): string {
  const b = base.trim();
  if (/^https?:\/\//i.test(b)) return b.replace(/\/+$/, '');
  const prefix = envUrl.replace(/\/+$/, '');
  if (b === '') return prefix;
  return `${prefix}${b.startsWith('/') ? '' : '/'}${b.replace(/\/+$/, '')}`;
}

/** The headers carrying one provider's key, in its own auth scheme. */
export function authHeaders(auth: AuthScheme, key: string): Record<string, string> {
  if (key === '') return {};
  if (auth === 'bearer') return { authorization: `Bearer ${key}` };
  if (auth === 'x-api-key') return { 'x-api-key': key };
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}

/** A price map that is all zeros means free; null when the listing says nothing. */
function zeroPriced(v: Json): boolean | null {
  const pricing = isRecord(v.pricing) ? v.pricing : null;
  if (pricing === null) return null;
  const values = Object.values(pricing).flatMap((x) => {
    if (typeof x === 'number') return [x];
    if (typeof x === 'string' && x.trim() !== '') return [Number(x)];
    return [];
  });
  if (values.length === 0) return null;
  return values.every((n) => Number.isFinite(n) && n === 0);
}

function modelIn(wire: Wire, v: unknown): ProbedModel | null {
  if (!isRecord(v)) return null;
  const id = wire === 'gemini' ? strOf(v.name).replace(/^models\//, '') : strOf(v.id);
  if (id === '') return null;
  return {
    id,
    display: strOf(v.display_name) !== '' ? strOf(v.display_name) : strOf(v.displayName) !== '' ? strOf(v.displayName) : id,
    free: boolOrNull(v.free) ?? zeroPriced(v),
    context: numOrNull(v.context_length) ?? numOrNull(v.context_window) ?? numOrNull(v.inputTokenLimit),
    tools: boolOrNull(v.tools),
    vision: boolOrNull(v.vision),
    json: boolOrNull(v.json),
  };
}

function modelsIn(wire: Wire, body: unknown): ProbedModel[] {
  if (!isRecord(body)) return [];
  const list = wire === 'gemini' ? body.models : body.data;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const m = modelIn(wire, v);
    return m === null ? [] : [m];
  });
}

/** Probe one provider's catalog route, in its own wire. Any failure leaves it out. */
export async function probeProvider(envUrl: string, provider: ProviderEntry, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  const base = joinBase(envUrl, provider.base);
  const url = provider.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'anthropic') headers['anthropic-version'] = ANTHROPIC_VERSION;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { provider, ok: false, models: [] };
    const body: unknown = await res.json();
    return { provider, ok: true, models: modelsIn(provider.wire, body) };
  } catch {
    return { provider, ok: false, models: [] };
  }
}

export function ratingOf(brief: Brief, providerId: string, modelId: string): RatingRow | null {
  return brief.ratings.find((r) => r.provider === providerId && r.model === modelId) ?? null;
}

export function modelIsFree(model: ProbedModel, row: RatingRow | null): boolean {
  if (row !== null) return row.free;
  return model.free ?? false;
}

export interface Caps {
  context: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

export function capsOf(model: ProbedModel, row: RatingRow | null): Caps {
  return {
    context: row?.context ?? model.context ?? null,
    tools: row?.tools ?? model.tools ?? null,
    vision: row?.vision ?? model.vision ?? null,
    json: row?.json ?? model.json ?? null,
  };
}

export function meetsReq(req: Requirement, caps: Caps): boolean {
  if (req.tools === true && caps.tools !== true) return false;
  if (req.vision === true && caps.vision !== true) return false;
  if (req.json === true && caps.json !== true) return false;
  if (req.min_context !== undefined && (caps.context === null || caps.context < req.min_context)) return false;
  return true;
}

/**
 * The one catalog: every provider that answered, every model it listed, sorted by id.
 * base_url is the directory's own path, never joined to the env origin, so the
 * document is identical on a live pass and its replay.
 */
export function buildCatalog(probes: readonly Probe[], brief: Brief): Catalog {
  const providers: CatalogProvider[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    const seen = new Set<string>();
    const models: CatalogModel[] = [];
    for (const model of [...probe.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const row = ratingOf(brief, probe.provider.id, model.id);
      models.push({ id: model.id, free: modelIsFree(model, row), context_length: row?.context ?? model.context ?? null });
    }
    providers.push({ id: probe.provider.id, base_url: probe.provider.base, key_env: probe.provider.key_env, wire: probe.provider.wire, models });
  }
  return { providers };
}


// ---------------------------------------------------------------------------
// Routing: the free candidates for one request, best rating first, and the
// per-provider state a trial accumulates (calls made, dead on budget/outage).
// ---------------------------------------------------------------------------

export interface Candidate {
  probe: Probe;
  model: ProbedModel;
  row: RatingRow | null;
  rating: number;
}

export interface ProviderState {
  dead: boolean;
  calls: number;
}

export const providerStates = new Map<string, ProviderState>();

function stateOf(providerId: string): ProviderState {
  let s = providerStates.get(providerId);
  if (s === undefined) {
    s = { dead: false, calls: 0 };
    providerStates.set(providerId, s);
  }
  return s;
}

function byRatingThenId(a: Candidate, b: Candidate): number {
  if (b.rating !== a.rating) return b.rating - a.rating;
  if (a.probe.provider.id !== b.probe.provider.id) return a.probe.provider.id < b.probe.provider.id ? -1 : 1;
  return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
}

/**
 * Free models meeting `req`, best rating first. `jsonOverOpenAI` is set when the
 * client asked for JSON mode on the OpenAI wire: an Anthropic-wire provider cannot
 * echo json_mode, so its models are not legal picks for that request.
 */
export function candidatesFor(brief: Brief, probes: readonly Probe[], req: Requirement, jsonOverOpenAI: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    if (jsonOverOpenAI && probe.provider.wire === 'anthropic') continue;
    for (const model of probe.models) {
      const row = ratingOf(brief, probe.provider.id, model.id);
      if (!modelIsFree(model, row)) continue;
      if (!meetsReq(req, capsOf(model, row))) continue;
      out.push({ probe, model, row, rating: row?.rating ?? 0 });
    }
  }
  out.sort(byRatingThenId);
  return out;
}

/** The free models this entry serves, for GET /v1/models: one row per model id. */
export function servedModels(brief: Brief, probes: readonly Probe[]): { id: string; provider: string; display: string }[] {
  const seen = new Set<string>();
  const out: { id: string; provider: string; display: string }[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (seen.has(model.id)) continue;
      const row = ratingOf(brief, probe.provider.id, model.id);
      if (!modelIsFree(model, row)) continue;
      seen.add(model.id);
      out.push({ id: model.id, provider: probe.provider.id, display: model.display });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upstream calls: one fetch per provider wire, returning status + raw text.
// A refusal's message tells whether the provider is spent for the trial.
// ---------------------------------------------------------------------------

export interface UpstreamResult {
  status: number;
  text: string;
  contentType: string;
}

export function errorMessageOf(status: number, text: string): string {
  try {
    const v: unknown = JSON.parse(text);
    if (isRecord(v)) {
      if (isRecord(v.error) && typeof v.error.message === 'string') return v.error.message;
      if (typeof v.message === 'string') return v.message;
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 300);
}

/** True when the refusal says the provider is done for this trial (budget/outage). */
export function refusalIsTerminal(message: string): boolean {
  return message.includes('budget is spent') || message.includes(' is out');
}

async function fetchUpstream(url: string, init: RequestInit): Promise<UpstreamResult> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get('content-type') ?? '' };
}

function openAIUpstreamBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  if (body.stream === true) out.stream_options = { include_usage: true };
  return out;
}

export async function callOpenAIWire(envUrl: string, probe: Probe, modelId: string, body: Json): Promise<UpstreamResult> {
  const base = joinBase(envUrl, probe.provider.base);
  return fetchUpstream(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: body.stream === true ? 'text/event-stream' : 'application/json', ...authHeaders(probe.provider.auth, probe.provider.key) },
    body: JSON.stringify(openAIUpstreamBody(body, modelId)),
  });
}

export async function callAnthropicWire(envUrl: string, probe: Probe, modelId: string, body: Json): Promise<UpstreamResult> {
  const base = joinBase(envUrl, probe.provider.base);
  return fetchUpstream(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: body.stream === true ? 'text/event-stream' : 'application/json', 'anthropic-version': ANTHROPIC_VERSION, ...authHeaders(probe.provider.auth, probe.provider.key) },
    body: JSON.stringify({ ...body, model: modelId }),
  });
}

export async function callGeminiWire(envUrl: string, probe: Probe, modelId: string, body: Json, stream: boolean): Promise<UpstreamResult> {
  const base = joinBase(envUrl, probe.provider.base);
  const path = stream ? `:streamGenerateContent?alt=sse` : ':generateContent';
  const url = `${base}/v1beta/models/${encodeURIComponent(modelId)}${path}`;
  return fetchUpstream(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', ...authHeaders(probe.provider.auth, probe.provider.key) },
    body: JSON.stringify(body),
  });
}


// ---------------------------------------------------------------------------
// Translation between the three wires. Every translator is echo-safe: the
// provider's echo of the translated request must match the client's sent body
// (system text, user text, image bytes, tool names, max_tokens, stops, JSON
// mode), so fields are carried across, never rewritten or dropped.
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = textOf(content);
    return t !== '' ? t : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function argsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: empty input.
    }
  }
  return {};
}

/** Anthropic Messages request as an OpenAI Chat Completions request. */
export function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: raw.role === 'assistant' ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (raw.role === 'assistant') {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: strOf(block.id),
          type: 'function',
          function: { name: strOf(block.name), arguments: JSON.stringify(isRecord(block.input) ? block.input : {}) },
        });
      }
      const text = textOf(content);
      messages.push({ role: 'assistant', content: text !== '' ? text : null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: strOf(block.tool_use_id), content: toolResultText(block.content) });
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
      if (block.type === 'image' && isRecord(block.source)) {
        const src = block.source;
        if (src.type === 'base64' && typeof src.data === 'string') {
          parts.push({ type: 'image_url', image_url: { url: `data:${strOf(src.media_type) !== '' ? strOf(src.media_type) : 'image/png'};base64,${src.data}` } });
        } else if (src.type === 'url' && typeof src.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [{ type: 'function', function: { name: raw.name, description: strOf(raw.description), parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} } } }];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** OpenAI Chat Completions request as an Anthropic Messages request. */
export function openAIToAnthropic(body: Json, model: string): Json {
  const out: Json = { model };
  const messages: Json[] = [];
  const source = Array.isArray(body.messages) ? body.messages : [];
  let systemText = '';
  // tool_result blocks ride on the most recent user message, so the echoed user
  // text (the last user message's text blocks) never changes.
  let lastUser: Json | null = null;
  const pushUser = (): Json => {
    const m: Json = { role: 'user', content: [] };
    messages.push(m);
    lastUser = m;
    return m;
  };
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const content = raw.content;
    if (raw.role === 'system') {
      const t = textOf(content);
      if (t !== '') systemText = systemText === '' ? t : `${systemText}\n${t}`;
      continue;
    }
    if (raw.role === 'assistant') {
      const blocks: Json[] = [];
      const text = textOf(content);
      if (text !== '') blocks.push({ type: 'text', text });
      const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        blocks.push({ type: 'tool_use', id: strOf(call.id) !== '' ? strOf(call.id) : 'toolu_unknown', name: strOf(call.function.name), input: argsOf(call.function.arguments) });
      }
      if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
      lastUser = null;
      continue;
    }
    if (raw.role === 'tool') {
      const block: Json = { type: 'tool_result', tool_use_id: strOf(raw.tool_call_id), content: typeof content === 'string' ? content : textOf(content) };
      const target = lastUser ?? pushUser();
      (target.content as Json[]).push(block);
      continue;
    }
    // user
    const target = pushUser();
    const parts = target.content as Json[];
    if (typeof content === 'string') {
      if (content !== '') parts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
        if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
          const url = part.image_url.url;
          const m = /^data:([^;,]*);base64,(.*)$/s.exec(url);
          if (m !== null) parts.push({ type: 'image', source: { type: 'base64', media_type: m[1] !== '' ? m[1] : 'image/png', data: m[2] } });
          else parts.push({ type: 'image', source: { type: 'url', url } });
        }
      }
    }
    if (parts.length === 0) messages.pop();
  }
  if (systemText !== '') out.system = systemText;
  out.messages = messages;
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === 'number') out.max_tokens = body.max_completion_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (typeof body.stop === 'string') out.stop_sequences = [body.stop];
  else if (Array.isArray(body.stop) && body.stop.length > 0) out.stop_sequences = body.stop;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return [];
      return [{ name: raw.function.name, description: strOf(raw.function.description), input_schema: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} } }];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (choice === 'required' || choice === 'any') out.tool_choice = { type: 'any' };
  else if (isRecord(choice) && choice.type === 'function' && isRecord(choice.function) && typeof choice.function.name === 'string') {
    out.tool_choice = { type: 'tool', name: choice.function.name };
  }
  if (body.stream === true) out.stream = true;
  return out;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string };
}

function openAIContentToGeminiParts(content: unknown): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (typeof content === 'string') {
    if (content !== '') parts.push({ text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push({ text: part.text });
    if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      const url = part.image_url.url;
      const m = /^data:([^;,]*);base64,(.*)$/s.exec(url);
      if (m !== null) parts.push({ inlineData: { mimeType: m[1] !== '' ? m[1] : 'image/png', data: m[2] } });
      else parts.push({ fileData: { fileUri: url } });
    }
  }
  return parts;
}

function anthropicContentToGeminiParts(content: unknown): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (typeof content === 'string') {
    if (content !== '') parts.push({ text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const block of content) {
    if (!isRecord(block)) continue;
    // tool_result blocks carry no text the echo counts: leave them out, so the
    // echoed user text stays exactly what the client sent.
    if (block.type === 'text' && typeof block.text === 'string') parts.push({ text: block.text });
    if (block.type === 'image' && isRecord(block.source)) {
      const src = block.source;
      if (src.type === 'base64' && typeof src.data === 'string') {
        parts.push({ inlineData: { mimeType: strOf(src.media_type) !== '' ? strOf(src.media_type) : 'image/png', data: src.data } });
      } else if (src.type === 'url' && typeof src.url === 'string') {
        parts.push({ fileData: { fileUri: src.url } });
      }
    }
  }
  return parts;
}

function toolsToGeminiDeclarations(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  const decls: Json[] = [];
  for (const raw of tools) {
    if (!isRecord(raw)) continue;
    if (typeof raw.name === 'string') {
      // Anthropic shape.
      decls.push({ name: raw.name, description: strOf(raw.description), parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} } });
    } else if (isRecord(raw.function) && typeof raw.function.name === 'string') {
      // OpenAI shape.
      decls.push({ name: raw.function.name, description: strOf(raw.function.description), parameters: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} } });
    }
  }
  return decls;
}

/** OpenAI Chat Completions request as a Gemini generateContent request. */
export function openAIToGemini(body: Json): Json {
  const contents: Json[] = [];
  let systemText = '';
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      const t = textOf(raw.content);
      if (t !== '') systemText = systemText === '' ? t : `${systemText}\n${t}`;
      continue;
    }
    // Tool messages echo nothing on any wire: leave them out rather than letting
    // their text become the last user content the echo reads.
    if (raw.role === 'tool') continue;
    const parts = openAIContentToGeminiParts(raw.content);
    if (parts.length === 0) continue;
    contents.push({ role: raw.role === 'assistant' ? 'model' : 'user', parts });
  }
  const out: Json = { contents };
  if (systemText !== '') out.systemInstruction = { parts: [{ text: systemText }] };
  const decls = toolsToGeminiDeclarations(body.tools);
  if (decls.length > 0) out.tools = [{ functionDeclarations: decls }];
  const config: Json = {};
  const max = typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : null;
  if (max !== null) config.maxOutputTokens = max;
  if (typeof body.temperature === 'number') config.temperature = body.temperature;
  if (typeof body.top_p === 'number') config.topP = body.top_p;
  if (typeof body.stop === 'string') config.stopSequences = [body.stop];
  else if (Array.isArray(body.stop) && body.stop.length > 0) config.stopSequences = body.stop;
  if (isRecord(body.response_format) && (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema')) {
    config.responseMimeType = 'application/json';
  }
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

/** Anthropic Messages request as a Gemini generateContent request. */
export function anthropicToGemini(body: Json): Json {
  const contents: Json[] = [];
  const systemText = textOf(body.system);
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const parts = anthropicContentToGeminiParts(raw.content);
    if (parts.length === 0) continue;
    contents.push({ role: raw.role === 'assistant' ? 'model' : 'user', parts });
  }
  const out: Json = { contents };
  if (systemText !== '') out.systemInstruction = { parts: [{ text: systemText }] };
  const decls = toolsToGeminiDeclarations(body.tools);
  if (decls.length > 0) out.tools = [{ functionDeclarations: decls }];
  const config: Json = {};
  if (typeof body.max_tokens === 'number') config.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === 'number') config.temperature = body.temperature;
  if (typeof body.top_p === 'number') config.topP = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) config.stopSequences = body.stop_sequences;
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

// ---------------------------------------------------------------------------
// Normalised provider answers: text, usage and stop, whatever the wire.
// ---------------------------------------------------------------------------

export interface ToolCallOut {
  id: string;
  name: string;
  args: Json;
}

export interface NormAnswer {
  text: string;
  input: number;
  output: number;
  stop: string;
  toolCalls: ToolCallOut[];
}

const numOrZero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function normFromOpenAI(body: Json): NormAnswer {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  const toolCalls: ToolCallOut[] = [];
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    toolCalls.push({ id: strOf(call.id) !== '' ? strOf(call.id) : 'toolu_unknown', name: strOf(call.function.name), args: argsOf(call.function.arguments) });
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  return { text, input: numOrZero(usage.prompt_tokens), output: numOrZero(usage.completion_tokens), stop: strOf(choice.finish_reason), toolCalls };
}

export function normFromAnthropic(body: Json): NormAnswer {
  const content = Array.isArray(body.content) ? body.content : [];
  let text = '';
  const toolCalls: ToolCallOut[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({ id: strOf(block.id) !== '' ? strOf(block.id) : 'toolu_unknown', name: strOf(block.name), args: isRecord(block.input) ? block.input : {} });
    }
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  return { text, input: numOrZero(usage.input_tokens), output: numOrZero(usage.output_tokens), stop: strOf(body.stop_reason), toolCalls };
}

export function normFromGemini(body: Json): NormAnswer {
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const first = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(first.content) ? first.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  let text = '';
  for (const part of parts) {
    if (isRecord(part) && typeof part.text === 'string') text += part.text;
  }
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return { text, input: numOrZero(usage.promptTokenCount), output: numOrZero(usage.candidatesTokenCount), stop: strOf(first.finishReason), toolCalls: [] };
}

/** Map any provider stop string to the OpenAI finish_reason family. */
export function toOpenAIStop(stop: string): string {
  if (stop === 'length' || stop === 'max_tokens' || stop === 'MAX_TOKENS') return 'length';
  if (stop === 'tool_calls' || stop === 'tool_use' || stop === 'function_call') return 'tool_calls';
  if (stop === 'content_filter' || stop === 'refusal' || stop === 'SAFETY') return 'content_filter';
  return 'stop';
}

/** Map any provider stop string to the Anthropic stop_reason family. */
export function toAnthropicStop(stop: string): string {
  if (stop === 'length' || stop === 'max_tokens' || stop === 'MAX_TOKENS') return 'max_tokens';
  if (stop === 'tool_calls' || stop === 'tool_use' || stop === 'function_call') return 'tool_use';
  if (stop === 'content_filter' || stop === 'refusal' || stop === 'SAFETY') return 'refusal';
  return 'end_turn';
}

export function openAIJsonAnswer(model: string, a: NormAnswer): Json {
  const message: Json = { role: 'assistant', content: a.text };
  if (a.toolCalls.length > 0) {
    message.tool_calls = a.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  }
  return {
    id: 'chatcmpl-agg',
    object: 'chat.completion',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, message, finish_reason: toOpenAIStop(a.stop), logprobs: null }],
    usage: { prompt_tokens: a.input, completion_tokens: a.output, total_tokens: a.input + a.output },
  };
}

export function anthropicJsonAnswer(model: string, a: NormAnswer): Json {
  const content: Json[] = [];
  if (a.text !== '') content.push({ type: 'text', text: a.text });
  for (const c of a.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: 'msg_agg',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: toAnthropicStop(a.stop),
    stop_sequence: null,
    usage: { input_tokens: a.input, output_tokens: a.output },
  };
}

// ---------------------------------------------------------------------------
// SSE: parse frames, then convert between the event shapes. The upstream text
// is read whole first, so usage (which arrives last on both streamed wires)
// is known before the first client event is written.
// ---------------------------------------------------------------------------

export interface SseFrame {
  event: string | null;
  data: string;
}

export function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  const normalized = text.replace(/\r\n/g, '\n');
  for (const chunk of normalized.split('\n\n')) {
    if (chunk.trim() === '') continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }
  return frames;
}

function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

interface OpenAIChunk {
  delta: Json;
  finish: string | null;
  usage: { input: number; output: number } | null;
}

function openAIChunksOf(frames: SseFrame[]): OpenAIChunk[] {
  const out: OpenAIChunk[] = [];
  for (const frame of frames) {
    if (frame.data.trim() === '[DONE]') continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!isRecord(chunk)) continue;
    if (isRecord(chunk.usage)) {
      out.push({ delta: {}, finish: null, usage: { input: numOrZero(chunk.usage.prompt_tokens), output: numOrZero(chunk.usage.completion_tokens) } });
      continue;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    if (choice === null) continue;
    out.push({ delta: isRecord(choice.delta) ? choice.delta : {}, finish: typeof choice.finish_reason === 'string' ? choice.finish_reason : null, usage: null });
  }
  return out;
}

/** Anthropic SSE frames as OpenAI chat-completion chunks, ending with [DONE]. */
export function openAIChunksFromAnthropic(frames: SseFrame[], model: string): string {
  let out = '';
  let input = 0;
  let output = 0;
  let stop = 'end_turn';
  let started = false;
  const chunk = (delta: Json, finish: string | null): Json => ({ id: 'chatcmpl-agg', object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  for (const frame of frames) {
    if (frame.event === null) continue;
    let data: unknown;
    try {
      data = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!isRecord(data)) continue;
    if (frame.event === 'message_start' && isRecord(data.message) && isRecord(data.message.usage)) {
      input = numOrZero(data.message.usage.input_tokens);
    } else if (frame.event === 'content_block_delta' && isRecord(data.delta)) {
      if (data.delta.type === 'text_delta' && typeof data.delta.text === 'string' && data.delta.text !== '') {
        if (!started) {
          out += sseData(chunk({ role: 'assistant', content: '' }, null));
          started = true;
        }
        out += sseData(chunk({ content: data.delta.text }, null));
      } else if (data.delta.type === 'input_json_delta' && typeof data.delta.partial_json === 'string' && data.delta.partial_json !== '') {
        if (!started) {
          out += sseData(chunk({ role: 'assistant', content: '' }, null));
          started = true;
        }
        out += sseData(chunk({ tool_calls: [{ index: 0, function: { arguments: data.delta.partial_json } }] }, null));
      }
    } else if (frame.event === 'message_delta') {
      if (isRecord(data.delta) && typeof data.delta.stop_reason === 'string') stop = data.delta.stop_reason;
      if (isRecord(data.usage)) output = numOrZero(data.usage.output_tokens);
    }
  }
  if (!started) out += sseData(chunk({ role: 'assistant', content: '' }, null));
  out += sseData(chunk({}, toOpenAIStop(stop)));
  out += sseData({ id: 'chatcmpl-agg', object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });
  out += 'data: [DONE]\n\n';
  return out;
}

/** OpenAI SSE chunks as the Anthropic event sequence. */
export function anthropicEventsFromOpenAI(frames: SseFrame[], model: string): string {
  const chunks = openAIChunksOf(frames);
  let input = 0;
  let output = 0;
  let stop: string | null = null;
  for (const c of chunks) {
    if (c.usage !== null) {
      input = c.usage.input;
      output = c.usage.output;
    }
    if (c.finish !== null) stop = c.finish;
  }
  const out: string[] = [];
  out.push(
    sseEvent('message_start', { type: 'message_start', message: { id: 'msg_agg', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } } }),
  );
  let textIndex = -1;
  let nextIndex = 0;
  const toolIndexes = new Map<number, number>();
  const closeText = (): void => {
    if (textIndex === -1) return;
    out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
    textIndex = -1;
  };
  for (const c of chunks) {
    const delta = c.delta;
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (textIndex === -1) {
        textIndex = nextIndex;
        nextIndex += 1;
        out.push(sseEvent('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }));
      }
      out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } }));
    }
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const call of calls) {
      if (!isRecord(call)) continue;
      const upstreamIndex = typeof call.index === 'number' ? call.index : toolIndexes.size;
      let index = toolIndexes.get(upstreamIndex);
      if (index === undefined) {
        closeText();
        index = nextIndex;
        nextIndex += 1;
        toolIndexes.set(upstreamIndex, index);
        const fn = isRecord(call.function) ? call.function : {};
        out.push(
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${index}`, name: strOf(fn.name), input: {} },
          }),
        );
      }
      const fn = isRecord(call.function) ? call.function : {};
      if (typeof fn.arguments === 'string' && fn.arguments !== '') {
        out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fn.arguments } }));
      }
    }
  }
  closeText();
  for (const index of [...toolIndexes.values()].sort((a, b) => a - b)) {
    out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
  }
  out.push(
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: toAnthropicStop(stop ?? 'stop'), stop_sequence: null }, usage: { output_tokens: output } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  );
  return out.join('');
}

interface GeminiFrame {
  text: string;
  finish: string | null;
  input: number;
  output: number;
}

function geminiFramesOf(frames: SseFrame[]): GeminiFrame[] {
  const out: GeminiFrame[] = [];
  for (const frame of frames) {
    let v: unknown;
    try {
      v = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!isRecord(v)) continue;
    const candidates = Array.isArray(v.candidates) ? v.candidates : [];
    const first = isRecord(candidates[0]) ? candidates[0] : {};
    const content = isRecord(first.content) ? first.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    let text = '';
    for (const part of parts) {
      if (isRecord(part) && typeof part.text === 'string') text += part.text;
    }
    const usage = isRecord(v.usageMetadata) ? v.usageMetadata : {};
    out.push({ text, finish: typeof first.finishReason === 'string' ? first.finishReason : null, input: numOrZero(usage.promptTokenCount), output: numOrZero(usage.candidatesTokenCount) });
  }
  return out;
}

/** Gemini SSE frames as OpenAI chat-completion chunks, ending with [DONE]. */
export function openAIChunksFromGemini(frames: SseFrame[], model: string): string {
  const parsed = geminiFramesOf(frames);
  let out = '';
  let input = 0;
  let output = 0;
  let stop = 'STOP';
  const chunk = (delta: Json, finish: string | null): Json => ({ id: 'chatcmpl-agg', object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  out += sseData(chunk({ role: 'assistant', content: '' }, null));
  for (const f of parsed) {
    if (f.text !== '') out += sseData(chunk({ content: f.text }, null));
    if (f.finish !== null) stop = f.finish;
    if (f.input !== 0 || f.output !== 0) {
      input = f.input;
      output = f.output;
    }
  }
  out += sseData(chunk({}, toOpenAIStop(stop)));
  out += sseData({ id: 'chatcmpl-agg', object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });
  out += 'data: [DONE]\n\n';
  return out;
}

/** Gemini SSE frames as the Anthropic event sequence. */
export function anthropicEventsFromGemini(frames: SseFrame[], model: string): string {
  const parsed = geminiFramesOf(frames);
  let input = 0;
  let output = 0;
  let stop = 'STOP';
  let text = '';
  for (const f of parsed) {
    text += f.text;
    if (f.finish !== null) stop = f.finish;
    if (f.input !== 0 || f.output !== 0) {
      input = f.input;
      output = f.output;
    }
  }
  const out: string[] = [];
  out.push(
    sseEvent('message_start', { type: 'message_start', message: { id: 'msg_agg', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } } }),
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  );
  // Emit the text in the same 13-char pieces the providers use; the joined text
  // is what the client checks, and the pieces keep no state.
  for (let at = 0; at < text.length; at += 13) {
    out.push(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(at, at + 13) } }));
  }
  out.push(
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: toAnthropicStop(stop), stop_sequence: null }, usage: { output_tokens: output } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  );
  return out.join('');
}


// ---------------------------------------------------------------------------
// Serving: one client request, tried against the ranked candidates until one
// answers. Exactly one successful provider call is ever used for a request.
// ---------------------------------------------------------------------------

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: Catalog = { providers: [] };
let manifestIndex = 0;

async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await Promise.all(brief.providers.map((p) => probeProvider(ENV_URL, p)));
  for (const probe of probes) {
    if (!probe.ok) log(`probe failed: ${probe.provider.id}`);
  }
  catalog = buildCatalog(probes, brief);
}

function requirementsFromBody(client: 'openai' | 'anthropic', body: Json): Requirement {
  const req: Requirement = {};
  if (Array.isArray(body.tools) && body.tools.length > 0) req.tools = true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    if (!isRecord(m) || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) req.vision = true;
    }
  }
  if (client === 'openai' && isRecord(body.response_format) && (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema')) {
    req.json = true;
  }
  return req;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendSse(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.end(text);
}

function openAIErrorBody(message: string, type: string): Json {
  return { error: { message, type, code: null } };
}

function anthropicErrorBody(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

function sendClientError(res: ServerResponse, client: 'openai' | 'anthropic', status: number, message: string): void {
  if (client === 'anthropic') sendJson(res, status, anthropicErrorBody('overloaded_error', message));
  else sendJson(res, status, openAIErrorBody(message, 'invalid_request_error'));
}

async function readJsonBody(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The upstream request body for one candidate, in that provider's wire. */
function upstreamBody(client: 'openai' | 'anthropic', wire: Wire, body: Json, modelId: string): Json {
  if (client === 'openai') {
    if (wire === 'openai') return body;
    if (wire === 'anthropic') return openAIToAnthropic(body, modelId);
    return openAIToGemini(body);
  }
  if (wire === 'openai') return anthropicToOpenAI(body, modelId);
  if (wire === 'anthropic') return body;
  return anthropicToGemini(body);
}

interface Served {
  candidate: Candidate;
  result: UpstreamResult;
}

/** Try the ranked candidates in order; return the first that answers 2xx. */
async function serveUpstream(client: 'openai' | 'anthropic', body: Json, candidates: Candidate[], stream: boolean): Promise<Served | null> {
  for (const candidate of candidates) {
    const state = stateOf(candidate.probe.provider.id);
    if (state.dead) continue;
    const wire = candidate.probe.provider.wire;
    const payload = upstreamBody(client, wire, body, candidate.model.id);
    let result: UpstreamResult;
    try {
      if (wire === 'openai') result = await callOpenAIWire(ENV_URL, candidate.probe, candidate.model.id, payload);
      else if (wire === 'anthropic') result = await callAnthropicWire(ENV_URL, candidate.probe, candidate.model.id, payload);
      else result = await callGeminiWire(ENV_URL, candidate.probe, candidate.model.id, payload, stream);
    } catch (err) {
      log(`call to ${candidate.probe.provider.id} failed: ${(err as Error).message}`);
      continue;
    }
    state.calls += 1;
    if (result.status >= 200 && result.status < 300) return { candidate, result };
    const message = errorMessageOf(result.status, result.text);
    if (refusalIsTerminal(message)) {
      state.dead = true;
      log(`${candidate.probe.provider.id} is done for this trial: ${message}`);
    } else {
      log(`${candidate.probe.provider.id} refused (${result.status}): ${message}`);
    }
  }
  return null;
}

/** The upstream answer, translated into the client's wire. */
function translateAnswer(client: 'openai' | 'anthropic', served: Served, stream: boolean): { json: Json | null; sse: string | null } {
  const wire = served.candidate.probe.provider.wire;
  const modelId = served.candidate.model.id;
  if (!stream) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(served.result.text);
    } catch {
      parsed = null;
    }
    const norm: NormAnswer = !isRecord(parsed)
      ? { text: '', input: 0, output: 0, stop: '', toolCalls: [] }
      : wire === 'openai'
        ? normFromOpenAI(parsed)
        : wire === 'anthropic'
          ? normFromAnthropic(parsed)
          : normFromGemini(parsed);
    return { json: client === 'openai' ? openAIJsonAnswer(modelId, norm) : anthropicJsonAnswer(modelId, norm), sse: null };
  }
  const frames = parseSse(served.result.text);
  if (client === 'openai' && wire === 'openai') return { json: null, sse: served.result.text };
  if (client === 'anthropic' && wire === 'anthropic') return { json: null, sse: served.result.text };
  if (client === 'openai' && wire === 'anthropic') return { json: null, sse: openAIChunksFromAnthropic(frames, modelId) };
  if (client === 'openai' && wire === 'gemini') return { json: null, sse: openAIChunksFromGemini(frames, modelId) };
  if (client === 'anthropic' && wire === 'openai') return { json: null, sse: anthropicEventsFromOpenAI(frames, modelId) };
  return { json: null, sse: anthropicEventsFromGemini(frames, modelId) };
}

async function serveRequest(req: IncomingMessage, res: ServerResponse, client: 'openai' | 'anthropic'): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) return sendClientError(res, client, 400, 'the request body is not one JSON object');
  const stream = body.stream === true;
  const manifest = brief.manifest[manifestIndex];
  manifestIndex += 1;
  const reqs = manifest !== undefined ? manifest.requires : requirementsFromBody(client, body);
  const jsonOverOpenAI = client === 'openai' && isRecord(body.response_format) && (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema');
  const candidates = candidatesFor(brief, probes, reqs, jsonOverOpenAI);
  const served = await serveUpstream(client, body, candidates, stream);
  if (served === null) return sendClientError(res, client, 503, 'no free model on the directory meets this request');
  const answer = translateAnswer(client, served, stream);
  if (answer.sse !== null) return sendSse(res, answer.sse);
  sendJson(res, 200, answer.json);
}

function modelsRoute(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels(brief, probes);
  if (typeof req.headers['x-api-key'] === 'string') {
    sendJson(res, 200, {
      data: list.map((m) => ({ type: 'model', id: m.id, display_name: m.display, created_at: FIXED_CREATED_AT })),
      has_more: false,
    });
  } else {
    sendJson(res, 200, {
      object: 'list',
      data: list.map((m) => ({ id: m.id, object: 'model', created: FIXED_CREATED, owned_by: m.provider })),
    });
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    modelsRoute(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await serveRequest(req, res, 'openai');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await serveRequest(req, res, 'anthropic');
    return;
  }
  sendClientError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('the server has no port'));
      resolve(address.port);
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const reply: unknown = await res.json();
      if (isRecord(reply) && reply.ok === true) {
        log(`registered: the workload holds ${typeof reply.requests === 'number' ? reply.requests : '?'} requests`);
        return;
      }
      throw new Error(`POST ${ENV_URL}/register answered ${JSON.stringify(reply).slice(0, 300)}`);
    } catch (err) {
      if (attempt === 39) throw err;
      await sleep(250);
    }
  }
}

function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const work: unknown = await res.json();
          if (isRecord(work) && work.done === true) {
            clearInterval(timer);
            server.close();
            process.exit(0);
          }
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_MS);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendClientError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'the server failed to answer');
    });
  });
  const port = await listen(server);
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} providers and ${servedModels(brief, probes).length} free models`);
  await register(port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
