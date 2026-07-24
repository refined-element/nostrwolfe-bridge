/** ListingCache — in-memory latest listing per address (spec §5). */

import type { IListingCache, ParsedListing } from "./types.js";

/**
 * Addressable-keyed store of the latest parsed 38400 per `38400:<pubkey>:<d>`.
 *
 * Spec §5 step 5: the cache holds the *full* latest event per address for
 * QueryResponder; the state file holds only dedupe metadata. It is rebuilt from
 * scratch on every startup by the full hydration REQ (§4) — never from the
 * cursor-windowed live sub — so it deliberately has no persistence of its own.
 */
export class ListingCache implements IListingCache {
  private readonly entries = new Map<string, ParsedListing>();

  get(address: string): ParsedListing | undefined {
    return this.entries.get(address);
  }

  set(address: string, listing: ParsedListing): void {
    this.entries.set(address, listing);
  }

  has(address: string): boolean {
    return this.entries.has(address);
  }

  delete(address: string): boolean {
    return this.entries.delete(address);
  }

  all(): ParsedListing[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}
