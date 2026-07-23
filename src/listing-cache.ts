/** ListingCache — in-memory latest listing per address (spec §5). */

import type { IListingCache, ParsedListing } from "./types.js";

export class ListingCache implements IListingCache {
  get(_address: string): ParsedListing | undefined {
    throw new Error("not implemented");
  }

  set(_address: string, _listing: ParsedListing): void {
    throw new Error("not implemented");
  }

  has(_address: string): boolean {
    throw new Error("not implemented");
  }

  delete(_address: string): boolean {
    throw new Error("not implemented");
  }

  all(): ParsedListing[] {
    throw new Error("not implemented");
  }

  get size(): number {
    throw new Error("not implemented");
  }
}
