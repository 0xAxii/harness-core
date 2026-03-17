import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  AuthorityRootPolicy,
  CapabilityProfile,
  LeaderUxMode,
  RuntimeTarget,
  SessionConfig,
  SessionConfigPath,
} from '../types/model.js';

const NETWORK_PROFILES = new Set<CapabilityProfile['network_profile']>(['deny', 'local', 'full']);
const RUNTIME_TARGETS = new Set<RuntimeTarget>(['codex']);
const AUTHORITY_ROOT_POLICIES = new Set<AuthorityRootPolicy>(['explicit', 'xdg-state']);
const LEADER_UX_MODES = new Set<LeaderUxMode>(['leader-first', 'worker-centric']);
const SESSION_CONFIG_KEYS = new Set<keyof SessionConfig>([
  'runtime_target',
  'authority_root_policy',
  'capability_defaults',
  'leader_ux_mode',
]);
const CAPABILITY_PROFILE_KEYS = new Set<keyof CapabilityProfile>([
  'fs_scope',
  'network_profile',
  'browser_access',
  'publish_right',
  'shared_resource_modes',
  'secret_classes',
]);

export interface LoadedSessionConfig {
  path: string;
  config: SessionConfig;
}

export function loadSessionConfig(configPath: SessionConfigPath): LoadedSessionConfig {
  const path = resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`failed to read session config at ${path}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in session config at ${path}: ${String(error)}`);
  }

  return {
    path,
    config: parseSessionConfig(parsed, `session config ${path}`),
  };
}

export function parseSessionConfig(value: unknown, source = 'session config'): SessionConfig {
  const record = assertRecord(value, source);
  assertOnlyKnownKeys(record, SESSION_CONFIG_KEYS, source);

  const runtimeTarget = expectString(record.runtime_target, `${source}.runtime_target`);
  if (!RUNTIME_TARGETS.has(runtimeTarget as RuntimeTarget)) {
    throw new Error(`${source}.runtime_target must be "codex"`);
  }

  const authorityRootPolicy = expectString(record.authority_root_policy, `${source}.authority_root_policy`);
  if (!AUTHORITY_ROOT_POLICIES.has(authorityRootPolicy as AuthorityRootPolicy)) {
    throw new Error(`${source}.authority_root_policy must be one of explicit|xdg-state`);
  }

  const leaderUxMode = expectString(record.leader_ux_mode, `${source}.leader_ux_mode`);
  if (!LEADER_UX_MODES.has(leaderUxMode as LeaderUxMode)) {
    throw new Error(`${source}.leader_ux_mode must be one of leader-first|worker-centric`);
  }

  return {
    runtime_target: runtimeTarget as RuntimeTarget,
    authority_root_policy: authorityRootPolicy as AuthorityRootPolicy,
    capability_defaults: parseCapabilityProfile(record.capability_defaults, `${source}.capability_defaults`),
    leader_ux_mode: leaderUxMode as LeaderUxMode,
  };
}

function parseCapabilityProfile(value: unknown, source: string): CapabilityProfile {
  const record = assertRecord(value, source);
  assertOnlyKnownKeys(record, CAPABILITY_PROFILE_KEYS, source);

  const networkProfile = expectString(record.network_profile, `${source}.network_profile`);
  if (!NETWORK_PROFILES.has(networkProfile as CapabilityProfile['network_profile'])) {
    throw new Error(`${source}.network_profile must be one of deny|local|full`);
  }

  return {
    fs_scope: expectStringArray(record.fs_scope, `${source}.fs_scope`),
    network_profile: networkProfile as CapabilityProfile['network_profile'],
    browser_access: expectBoolean(record.browser_access, `${source}.browser_access`),
    publish_right: expectBoolean(record.publish_right, `${source}.publish_right`),
    shared_resource_modes: expectStringArray(record.shared_resource_modes, `${source}.shared_resource_modes`),
    secret_classes: expectStringArray(record.secret_classes, `${source}.secret_classes`),
  };
}

function assertRecord(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  source: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${source} contains unsupported key: ${key}`);
    }
  }
}

function expectString(value: unknown, source: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${source} must be a non-empty string`);
  }
  return value.trim();
}

function expectBoolean(value: unknown, source: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${source} must be a boolean`);
  }
  return value;
}

function expectStringArray(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${source} must be an array of strings`);
  }
  return [...new Set(value.map((item) => item.trim()).filter((item) => item.length > 0))];
}
