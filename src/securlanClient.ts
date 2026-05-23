import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

import { DEFAULT_ALARM_BASE_URL, DEFAULT_BASE_URL, DEFAULT_REQUEST_TIMEOUT_MS } from './settings';
import type {
  SecurlanAlarmSectorState,
  SecurlanOutputConfig,
  SecurlanOutputState,
  SecurlanSensorState,
} from './types';

interface ClientOptions {
  baseUrl?: string;
  alarmBaseUrl?: string;
  username: string;
  password: string;
  requestTimeoutMs?: number;
}

type Portal = 'ev' | 'mp';

export class SecurlanClient {
  private readonly baseUrl: string;
  private readonly alarmBaseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly requestTimeoutMs: number;
  private readonly cookies = {
    ev: new Map<string, string>(),
    mp: new Map<string, string>(),
  };
  private outputCache?: SecurlanOutputState[];
  private outputCacheTime = 0;
  private loggedIn = {
    ev: false,
    mp: false,
  };

  constructor(options: ClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.alarmBaseUrl = trimTrailingSlash(options.alarmBaseUrl ?? DEFAULT_ALARM_BASE_URL);
    this.username = options.username;
    this.password = options.password;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async getSensors(sector = 'TUTTI'): Promise<SecurlanSensorState[]> {
    await this.ensureLoggedIn('ev');
    const html = await this.requestText(`/ZonePerSettore.php?ricopzione=103&settore=${encodeURIComponent(sector)}`);
    return parseSensors(html);
  }

  async triggerOutput(output: SecurlanOutputConfig): Promise<void> {
    await this.ensureLoggedIn('ev');

    const outputId = output.idIndex !== undefined || output.name
      ? await this.resolveOutputId(output, true)
      : output.id ?? await this.resolveOutputId(output, true);
    const form = new URLSearchParams();
    form.set(outputId, '');
    form.set('submit', 'Invia richiesta');

    await this.requestText('/Uscite.php', {
      method: 'POST',
      body: form,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  }

  async getOutputIds(): Promise<string[]> {
    const outputs = await this.getOutputs();
    return outputs.map(output => output.id);
  }

  async getOutputs(forceRefresh = false): Promise<SecurlanOutputState[]> {
    if (this.outputCache && !forceRefresh && Date.now() - this.outputCacheTime < 10 * 60 * 1000) {
      return this.outputCache;
    }

    await this.ensureLoggedIn('ev');
    const html = await this.requestText('/Uscite.php?ricopzione=106');
    this.outputCache = parseOutputs(html);
    this.outputCacheTime = Date.now();
    return this.outputCache;
  }

  async getAlarmSectors(): Promise<SecurlanAlarmSectorState[]> {
    await this.ensureLoggedIn('mp');
    const html = await this.requestText('/SettConZoneAperteEscludibili.php', {}, 'mp');
    return parseAlarmSectors(html);
  }

  async setAlarmSectors(desiredStates: Record<string, boolean>): Promise<SecurlanAlarmSectorState[]> {
    const sectors = await this.getAlarmSectors();
    const normalizedDesiredStates = normalizeDesiredAlarmStates(desiredStates);
    const form = new URLSearchParams();
    form.set('submit', 'Invia richiesta');

    for (const sector of sectors) {
      const targetArmed = normalizedDesiredStates.get(normalizeAlarmSectorKey(sector.id))
        ?? normalizedDesiredStates.get(normalizeAlarmSectorKey(sector.name))
        ?? sector.armed;

      if (!targetArmed) {
        continue;
      }

      if (!sector.formName) {
        throw new Error(`Settore allarme ${sector.name} senza id form CWebForce: impossibile comandarlo.`);
      }

      form.set(sector.formName, '');
    }

    await this.requestText('/SettConZoneAperteEscludibili.php', {
      method: 'POST',
      body: form,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }, 'mp');

    return this.getAlarmSectors();
  }

  private async resolveOutputId(output: SecurlanOutputConfig, forceRefresh = false): Promise<string> {
    const outputs = await this.getOutputs(forceRefresh);
    const byName = output.name
      ? outputs.find(item => normalizeName(item.name) === normalizeName(output.name ?? ''))
      : undefined;

    if (byName) {
      return byName.id;
    }

    const index = output.idIndex ?? 0;
    const id = outputs[index]?.id;

    if (!id) {
      throw new Error(`Output "${output.name ?? index}" not found. Found ${outputs.length} output ids.`);
    }

    return id;
  }

  private async ensureLoggedIn(portal: Portal): Promise<void> {
    if (this.loggedIn[portal]) {
      return;
    }

    await this.requestText('/index.php', { skipAuthRetry: true }, portal);

    const form = new URLSearchParams();
    form.set('uid', this.username);
    form.set('pwd', this.password);
    const mobileAlarmLogin = portal === 'mp' && /\/mp$/i.test(this.alarmBaseUrl);
    form.set(mobileAlarmLogin ? 'submit' : 'Entra', mobileAlarmLogin ? 'login' : '');

    const html = await this.requestText('/Scelte.php', {
      method: 'POST',
      body: form,
      skipAuthRetry: true,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }, portal);

    if (looksLikeLoginPage(html)) {
      throw new Error('Login Securlan/CWebForce non riuscito: controlla utente e password.');
    }

    this.loggedIn[portal] = true;
    if (portal === 'ev') {
      this.outputCache = undefined;
      this.outputCacheTime = 0;
    }
  }

  private async requestText(
    path: string,
    init: RequestInit & { skipAuthRetry?: boolean } = {},
    portal: Portal = 'ev',
  ): Promise<string> {
    const response = await this.fetch(path, init, portal);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`CWebForce HTTP ${response.status} on ${path}`);
    }

    if (!init.skipAuthRetry && looksLikeLoginPage(text)) {
      this.loggedIn[portal] = false;
      if (portal === 'ev') {
        this.outputCache = undefined;
        this.outputCacheTime = 0;
      }
      await this.ensureLoggedIn(portal);
      return this.requestText(path, { ...init, skipAuthRetry: true }, portal);
    }

    return text;
  }

  private async fetch(path: string, init: RequestInit = {}, portal: Portal = 'ev'): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const headers = new Headers(init.headers);
    const cookies = this.cookies[portal];

    if (cookies.size > 0) {
      headers.set('Cookie', [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; '));
    }

    try {
      const response = await fetch(`${portal === 'mp' ? this.alarmBaseUrl : this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      this.storeCookies(response, portal);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private storeCookies(response: Response, portal: Portal): void {
    const setCookie = response.headers.getSetCookie?.() ?? [];
    const cookies = this.cookies[portal];

    for (const cookie of setCookie) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (separator > 0) {
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
  }
}

export function parseSensors(html: string): SecurlanSensorState[] {
  const sensors: SecurlanSensorState[] = [];
  const pattern = /<b>[^<]+<\/b><br>([^<]+)<br>Stato:\s*([^<.]+)\./g;

  for (const match of html.matchAll(pattern)) {
    const $ = cheerio.load(match[1]);
    const name = $.root().text().split(' - ')[0].trim();
    const rawState = match[2].trim().toUpperCase();

    if (name && rawState) {
      sensors.push({ name, rawState });
    }
  }

  return sensors;
}

export function parseOutputs(html: string): SecurlanOutputState[] {
  const $ = cheerio.load(html);
  const outputs: SecurlanOutputState[] = [];
  const seenIds = new Set<string>();

  $('[id]').each((_index, element) => {
    const id = $(element).attr('id')?.trim();
    if (!id || !/^\d{2}-\d{4}-\d-\d{4}$/.test(id) || seenIds.has(id)) {
      return;
    }

    seenIds.add(id);
    const idIndex = outputs.length;
    const name = findOutputName($, $(element), id, idIndex);
    outputs.push({ id, idIndex, name });
  });

  if (outputs.length > 0) {
    return outputs;
  }

  return [...html.matchAll(/id="(\d{2}-\d{4}-\d-\d{4})"/g)].map((match, index) => ({
    id: match[1],
    idIndex: index,
    name: `Uscita ${index + 1}`,
  }));
}

export function parseAlarmSectors(html: string): SecurlanAlarmSectorState[] {
  const $ = cheerio.load(html);
  const sectorIds = new Set<string>();
  const armedSectorIds = new Set<string>();
  const formNamesBySectorId = new Map<string, string>();

  $('input[type="checkbox"][name]').each((_index, element) => {
    const name = $(element).attr('name')?.trim();
    if (!name) {
      return;
    }

    const match = name.match(/^01-(\d{3})/);
    if (!match) {
      return;
    }

    const id = match[1];
    sectorIds.add(id);
    if (checkboxIsChecked($, $(element))) {
      armedSectorIds.add(id);
    }
    formNamesBySectorId.set(id, name);
  });

  for (const match of html.matchAll(/<input\b[^>]*name=["'](01-(\d{3})[^"']*)["'][^>]*>/gi)) {
    const [, formName, id] = match;
    sectorIds.add(id);
    if (inputTagLooksChecked(match[0])) {
      armedSectorIds.add(id);
    }
    formNamesBySectorId.set(id, formName);
  }

  const firstFormName = formNamesBySectorId.values().next().value;
  for (let index = 1; index <= 5; index += 1) {
    sectorIds.add(String(index).padStart(3, '0'));
  }

  return [...sectorIds]
    .sort()
    .map(id => {
      const formName = formNamesBySectorId.get(id)
        ?? (firstFormName ? firstFormName.replace(/^01-\d{3}/, `01-${id}`) : undefined);

      return {
        id,
        name: `A${Number(id)}`,
        armed: armedSectorIds.has(id),
        formName,
      };
    });
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function checkboxIsChecked($: cheerio.CheerioAPI, element: cheerio.Cheerio<AnyNode>): boolean {
  const checked = element.attr('checked');
  const ariaChecked = element.attr('aria-checked');
  const elementClass = element.attr('class') ?? '';
  const parentClass = element.parent().attr('class') ?? '';
  const labelClass = $(`label[for="${escapeSelector(element.attr('id') ?? '')}"]`).attr('class') ?? '';

  return checked !== undefined
    || ariaChecked === 'true'
    || /\b(ui-checkbox-on|checked)\b/i.test(`${elementClass} ${parentClass} ${labelClass}`);
}

function inputTagLooksChecked(tag: string): boolean {
  return /\bchecked(?:\s*=\s*(?:"checked"|'checked'|checked|"true"|'true'|true))?\b/i.test(tag)
    || /\baria-checked\s*=\s*(?:"true"|'true'|true)/i.test(tag)
    || /\bui-checkbox-on\b/i.test(tag);
}

function looksLikeLoginPage(html: string): boolean {
  return /name=["']uid["']/i.test(html) && /name=["']pwd["']/i.test(html);
}

function findOutputName(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<AnyNode>,
  id: string,
  index: number,
): string {
  const label = $(`label[for="${escapeSelector(id)}"]`).first().text();
  const candidate = cleanOutputText(label)
    || cleanOutputText(element.attr('value') ?? '')
    || cleanOutputText(element.attr('name') ?? '');

  if (candidate && candidate !== id) {
    return candidate;
  }

  for (const selector of ['tr', 'li', 'p', 'div', 'form']) {
    const container = element.closest(selector);
    const text = cleanOutputText(container.text(), id);
    if (text) {
      return text;
    }
  }

  return `Uscita ${index + 1}`;
}

function cleanOutputText(value: string, idToRemove?: string): string {
  let text = value
    .replace(/\s+/g, ' ')
    .replace(/Invia richiesta/gi, '')
    .replace(/Submit/gi, '')
    .replace(/^UU_\d+\s*\([^)]+\)\s*/i, '')
    .trim();

  if (idToRemove) {
    text = text.replaceAll(idToRemove, '').trim();
  }

  return text
    .replace(/^[\s:.-]+|[\s:.-]+$/g, '')
    .trim();
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeDesiredAlarmStates(desiredStates: Record<string, boolean>): Map<string, boolean> {
  const normalized = new Map<string, boolean>();
  for (const [key, value] of Object.entries(desiredStates)) {
    normalized.set(normalizeAlarmSectorKey(key), value);
  }
  return normalized;
}

function normalizeAlarmSectorKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const sectorMatch = trimmed.match(/^a?(\d+)$/);
  if (sectorMatch) {
    return String(Number(sectorMatch[1])).padStart(3, '0');
  }

  return trimmed;
}

function escapeSelector(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
