export interface Warning {
  code: string;
  message: string;
  count: number;
  examples: string[];
}

/** Collects approximations and unsupported features so the user gets an honest conversion report. */
export class Report {
  private items = new Map<string, Warning>();
  stats = { pages: 0, artboards: 0, layers: 0, symbols: 0, instances: 0, detached: 0, images: 0, texts: 0, stacks: 0, swatches: 0 };

  warn(code: string, message: string, where?: string): void {
    let w = this.items.get(code);
    if (!w) {
      w = { code, message, count: 0, examples: [] };
      this.items.set(code, w);
    }
    w.count++;
    if (where && w.examples.length < 8 && !w.examples.includes(where)) w.examples.push(where);
  }

  get warnings(): Warning[] {
    return [...this.items.values()].sort((a, b) => b.count - a.count);
  }
}
