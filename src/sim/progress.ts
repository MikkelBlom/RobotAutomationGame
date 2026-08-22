import { capDeck, capWeight, capability, type CrateMaterialValue, type CrateShapeValue } from './cargo';
import { crateValue } from './economy';

/**
 * Money, the electricity account, the day's quota, and everything that can be
 * bought.
 *
 * This is the spine the game hangs off. It is deliberately data rather than
 * code: an upgrade is a row in a table, and adding one should never mean
 * touching the machinery that spends money or draws plates.
 */

// ── The quota ───────────────────────────────────────────────────────────────

/**
 * One line of a day's order.
 *
 * Typed from the start, even while every line is always timber 1x1. The factory
 * phase needs the quota to be able to ask for built goods, and retrofitting item
 * types into a plain crate counter later is expensive where designing it in now
 * is free. `material`/`shape` become one arm of a wider item union when
 * manufactured goods exist.
 */
export interface QuotaLine {
  material: CrateMaterialValue;
  shape: CrateShapeValue;
  required: number;
  shipped: number;
}

export interface Quota {
  day: number;
  lines: QuotaLine[];
}

/** Whether every line of the day's order has been met. */
export function quotaMet(quota: Quota): boolean {
  return quota.lines.every((l) => l.shipped >= l.required);
}

export function quotaRemaining(quota: Quota): number {
  return quota.lines.reduce((n, l) => n + Math.max(0, l.required - l.shipped), 0);
}

export function quotaRequired(quota: Quota): number {
  return quota.lines.reduce((n, l) => n + l.required, 0);
}

export function quotaShipped(quota: Quota): number {
  return quota.lines.reduce((n, l) => n + Math.min(l.shipped, l.required), 0);
}

/**
 * The order for a given day.
 *
 * Gentle: the first day is meant to be met by anyone who touches the controls,
 * because the whole of day one is a tutorial. It steepens slowly and is capped,
 * since a quota the building cannot supply is just a permanently red board.
 */
export function quotaForDay(day: number): Quota {
  const required = Math.min(60, 8 + day * 4);
  return {
    day,
    lines: [{ material: 0 as CrateMaterialValue, shape: 0 as CrateShapeValue, required, shipped: 0 }],
  };
}

// ── Electricity ─────────────────────────────────────────────────────────────

/**
 * What a full charge costs.
 *
 * Set against what the work is worth rather than picked: a crate costs about
 * 0.025 of a charge to move and sells for 45, so this puts power at roughly a
 * seventh of revenue — felt, but never the reason a day goes badly.
 */
export const CHARGE_PRICE = 260;

/** The trickle socket charges at this fraction of a commissioned pad's rate. */
export const TRICKLE_RATE = 0.2;

// ── Upgrades ────────────────────────────────────────────────────────────────

export const UpgradeScope = { Bot: 0, Global: 1 } as const;
export type UpgradeScopeValue = (typeof UpgradeScope)[keyof typeof UpgradeScope];

export interface UpgradeDef {
  id: string;
  name: string;
  /** One line, shown on the plate's sign. */
  blurb: string;
  scope: UpgradeScopeValue;
  /**
   * Levels available.
   *
   * Per-bot lines stop at five: every level costs a trip to the shop with that
   * particular machine, and that trip is the real price. Global lines run long,
   * because they cost nothing but money and are where the tail of progression
   * lives.
   */
  levels: number;
  /** Price of level `n` (1-based). */
  price: (level: number) => number;
  /** Hidden until this returns true. */
  available?: (p: Progress) => boolean;
}

/**
 * Geometric pricing with a fixed base.
 *
 * The ratio is what stops a line being finished in the phase that introduced
 * it: at 1.6 a five-level line costs seven times its first level altogether, so
 * the last step is still a real decision long after the first was trivial.
 */
function curve(base: number, ratio = 1.6): (level: number) => number {
  return (level) => Math.round(base * Math.pow(ratio, level - 1));
}

export const UPGRADES: UpgradeDef[] = [
  {
    id: 'chargePoint',
    name: 'Charge point',
    blurb: 'Commission a bay on the east wall',
    scope: UpgradeScope.Global,
    levels: 10,
    price: curve(420, 1.45),
  },
  {
    id: 'queue',
    name: 'Order queue',
    blurb: 'Stack one more order per machine',
    scope: UpgradeScope.Global,
    levels: 25,
    price: curve(300, 1.35),
  },
  {
    id: 'autoCharge',
    name: 'Auto-charge',
    blurb: 'Takes itself to a free point when low',
    scope: UpgradeScope.Bot,
    levels: 1,
    price: curve(900),
  },
  {
    id: 'autoPickup',
    name: 'Auto-collect',
    blurb: 'Finds and collects a crate on its own',
    scope: UpgradeScope.Bot,
    levels: 1,
    price: curve(1400),
  },
  {
    id: 'autoDeliver',
    name: 'Auto-deliver',
    blurb: 'Takes what it holds to a waiting trailer',
    scope: UpgradeScope.Bot,
    levels: 1,
    price: curve(2200),
    available: (p) => p.botUpgradeAnywhere('autoPickup') > 0,
  },
  {
    id: 'speed',
    name: 'Drive speed',
    blurb: 'Faster across the floor',
    scope: UpgradeScope.Bot,
    levels: 5,
    price: curve(500),
  },
  {
    id: 'battery',
    name: 'Battery',
    blurb: 'A longer shift between charges',
    scope: UpgradeScope.Bot,
    levels: 5,
    price: curve(450),
  },
  {
    id: 'deck',
    name: 'Deck size',
    blurb: 'Carry a bigger crate',
    scope: UpgradeScope.Bot,
    levels: 2,
    price: curve(3000, 2.4),
  },
  {
    id: 'weight',
    name: 'Heavy lift',
    blurb: 'Rated for steel',
    scope: UpgradeScope.Bot,
    levels: 1,
    price: curve(9000),
  },
  {
    id: 'bot',
    name: 'Another machine',
    blurb: 'One more hauler on the floor',
    scope: UpgradeScope.Global,
    levels: 40,
    price: curve(1600, 1.5),
  },
  {
    id: 'autoDispatch',
    name: 'Auto-dispatch',
    blurb: 'Trailers leave when full, unattended',
    scope: UpgradeScope.Global,
    levels: 1,
    price: curve(3500),
  },
  {
    id: 'dock',
    name: 'Open a loading dock',
    blurb: 'Another bay in service',
    scope: UpgradeScope.Global,
    levels: 3,
    price: curve(6000, 1.8),
  },
];

export const UPGRADE_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

/** Deck capacity at each level of the deck line, in crate units. */
const DECK_STEPS = [1, 2, 4];

// ── State ───────────────────────────────────────────────────────────────────

export class Progress {
  money = 0;
  /**
   * Unpaid electricity.
   *
   * Power is never refused. Drawing with no money puts it here instead, and
   * income clears it before anything becomes profit. That is what makes a flat
   * battery with an empty wallet a slow patch rather than a dead end — and it
   * is not exploitable the way simply waiving the charge would have been, since
   * a player who spends to zero before every charge would otherwise get their
   * power free.
   */
  tab = 0;

  /** Global upgrade levels, by id. */
  private readonly global = new Map<string, number>();
  /** Per-bot upgrade levels: bot index -> id -> level. */
  private readonly perBot = new Map<number, Map<string, number>>();

  /** Set once the first trailer has been sent away. Opens the shop. */
  shopOpen = false;
  /** Set when the first trailer is dispatched. The water opens after that. */
  waterOpen = false;

  quota: Quota = quotaForDay(1);
  /** Days whose quota was missed. Costs money, never the run. */
  missedDays = 0;

  levelOf(id: string): number {
    return this.global.get(id) ?? 0;
  }

  botLevelOf(bot: number, id: string): number {
    return this.perBot.get(bot)?.get(id) ?? 0;
  }

  /** Highest level of a per-bot line owned by any machine. Gates other lines. */
  botUpgradeAnywhere(id: string): number {
    let best = 0;
    for (const owned of this.perBot.values()) best = Math.max(best, owned.get(id) ?? 0);
    return best;
  }

  /** Next level of a line for a given machine, or 0 when it is finished. */
  nextLevel(def: UpgradeDef, bot: number): number {
    const owned = def.scope === UpgradeScope.Global ? this.levelOf(def.id) : this.botLevelOf(bot, def.id);
    return owned >= def.levels ? 0 : owned + 1;
  }

  priceOf(def: UpgradeDef, bot: number): number {
    const next = this.nextLevel(def, bot);
    return next === 0 ? 0 : def.price(next);
  }

  /** Whether a line should appear on a plate at all yet. */
  visible(def: UpgradeDef): boolean {
    return def.available ? def.available(this) : true;
  }

  canAfford(def: UpgradeDef, bot: number): boolean {
    const next = this.nextLevel(def, bot);
    if (next === 0) return false;
    return this.money >= def.price(next);
  }

  /** Takes the money and records the level. Returns the level bought, or 0. */
  buy(def: UpgradeDef, bot: number): number {
    const next = this.nextLevel(def, bot);
    if (next === 0) return 0;
    const price = def.price(next);
    if (this.money < price) return 0;
    this.money -= price;
    if (def.scope === UpgradeScope.Global) {
      this.global.set(def.id, next);
    } else {
      let owned = this.perBot.get(bot);
      if (!owned) {
        owned = new Map();
        this.perBot.set(bot, owned);
      }
      owned.set(def.id, next);
    }
    return next;
  }

  /**
   * Banks income, clearing the electricity account first.
   *
   * Debt is paid before profit, so a player who has run one up sees their next
   * few loads go on it rather than being asked to do anything about it.
   */
  earn(amount: number): void {
    if (this.tab > 0) {
      const paid = Math.min(this.tab, amount);
      this.tab -= paid;
      amount -= paid;
    }
    this.money += amount;
  }

  /** Bills power. Anything unaffordable goes on the account. */
  bill(amount: number): void {
    if (amount <= 0) return;
    const paid = Math.min(this.money, amount);
    this.money -= paid;
    this.tab += amount - paid;
  }

  /** Records a crate shipped, against the quota and the till. */
  ship(material: CrateMaterialValue, shape: CrateShapeValue): void {
    this.earn(crateValue(material, shape));
    for (const line of this.quota.lines) {
      if (line.material === material && line.shape === shape) {
        line.shipped++;
        return;
      }
    }
  }

  /** The machine's capability, given what it has been upgraded with. */
  capabilityOf(bot: number, base: number): number {
    const deck = DECK_STEPS[Math.min(DECK_STEPS.length - 1, this.botLevelOf(bot, 'deck'))];
    const weight = capWeight(base) + this.botLevelOf(bot, 'weight');
    return capability(Math.max(capDeck(base), deck), weight);
  }
}
