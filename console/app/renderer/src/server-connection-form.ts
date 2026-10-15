/** Values and controls shared by inventory Add and first-run connection setup. */
export interface TargetDiscoveryData {
  wsl?: string[] | { unavailable: string };
  localLinux?: { available: boolean; reason?: string };
  containers?: Array<{ project?: string }> | { unavailable: string };
}
export interface ConnectionInput {
  name: string;
  connectionKind: 'wsl';
  wslDistribution: string;
}
export interface ConnectionControl {
  id: string; label: string; kind: string; value: unknown;
  options?: string[]; min?: number; max?: number; info?: string;
}

export const CONNECTION_CAPABILITY_NOTE = 'This build connects to discovered WSL distributions. SSH, Docker and native Linux connections are unavailable. Existing saved profiles are retained.';

export function assertConnectionType(prefix: 'sv' | 'ob', values: Record<string, unknown>): void {
  const local = prefix === 'sv' ? 'Local' : 'This machine';
  const label = String(values[prefix === 'sv' ? 'sv_kind' : 'ob_where'] ?? local);
  if (label !== local) throw new Error(`${label} connections are unavailable in this build. Choose the WSL connection type and a discovered distribution.`);
}

export function connectionFormControls(prefix: 'sv' | 'ob', _values: Record<string, unknown>, discovery: TargetDiscoveryData): ConnectionControl[] {
  const id = (field: string) => `${prefix}_${field}`;
  const kindId = prefix === 'sv' ? 'sv_kind' : 'ob_where';
  const local = prefix === 'sv' ? 'Local' : 'This machine';
  return [
    { id: kindId, label: 'Connection type (WSL)', kind: 'segmented', value: local, options: [local], info: CONNECTION_CAPABILITY_NOTE },
    { id: id('name'), label: 'Connection name', kind: 'text', value: '', info: 'Optional display name. When blank, the selected WSL distribution name is used.' },
    { id: id('distribution'), label: 'WSL distribution', kind: 'select', value: '',
      options: Array.isArray(discovery.wsl) ? discovery.wsl : [],
      info: Array.isArray(discovery.wsl) && discovery.wsl.length ? 'Choose an exact name read from this host. No distribution is selected automatically for a saved connection.' : (discovery.wsl && !Array.isArray(discovery.wsl) ? discovery.wsl.unavailable : 'No WSL distribution has been discovered. Use Discover local targets and retry.'),
    },
  ];
}

export function connectionInput(prefix: 'sv' | 'ob', values: Record<string, unknown>, discovery: TargetDiscoveryData): ConnectionInput {
  assertConnectionType(prefix, values);
  const distribution = String(values[`${prefix}_distribution`] ?? '').trim();
  if (!distribution || !Array.isArray(discovery.wsl) || !discovery.wsl.includes(distribution)) throw new Error('Choose a WSL distribution from the current discovery result.');
  return {
    name: String(values[`${prefix}_name`] ?? '').trim() || distribution,
    connectionKind: 'wsl',
    wslDistribution: distribution,
  };
}
