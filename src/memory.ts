const MAX_HISTORY = 10;

export interface MemoryEntry {
  raw: string;
  structured: string;
  mode: string;
  timestamp: number;
}

const history: MemoryEntry[] = [];

export function addToMemory(entry: Omit<MemoryEntry, 'timestamp'>): void {
  history.push({ ...entry, timestamp: Date.now() });
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

export function getMemory(): MemoryEntry[] {
  return [...history];
}

export function getMemoryContext(): string {
  if (history.length === 0) return '';

  const lines = history.map((entry, i) => {
    const ago = Math.round((Date.now() - entry.timestamp) / 1000);
    const timeLabel = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
    return `[${i + 1}/${history.length} — ${timeLabel}]\nUser said: ${entry.raw}\nStructured as: ${entry.structured}`;
  });

  return `Recent conversation context (last ${history.length} entries):\n${lines.join('\n\n')}`;
}

export function clearMemory(): void {
  history.length = 0;
}
