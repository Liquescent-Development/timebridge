/**
 * Wrapper around bloom-filters npm package to provide compatibility
 * with our existing API while reducing code maintenance
 */

import { BloomFilter as NPMBloomFilter } from 'bloom-filters';

export class BloomFilter {
  private filter: NPMBloomFilter;
  private itemCount: number = 0;
  private expectedItems: number;
  private falsePositiveRate: number;

  /**
   * Create a new Bloom filter
   * @param expectedItems Expected number of items to be added
   * @param falsePositiveRate Desired false positive rate (default 0.001 = 0.1%)
   */
  constructor(expectedItems: number = 10000, falsePositiveRate: number = 0.001) {
    this.expectedItems = expectedItems;
    this.falsePositiveRate = falsePositiveRate;
    
    // Create optimal bloom filter for the expected items and error rate
    this.filter = NPMBloomFilter.create(expectedItems, falsePositiveRate);
    
    console.log(`[BloomFilter] Created with optimal size for ${expectedItems} expected items, ${falsePositiveRate} FPR`);
  }

  /**
   * Add an item to the filter
   */
  add(item: string): void {
    this.filter.add(item);
    this.itemCount++;
  }

  /**
   * Add multiple items to the filter
   */
  addAll(items: Iterable<string>): void {
    for (const item of items) {
      this.add(item);
    }
  }

  /**
   * Check if an item might be in the set
   * @returns true if item might be in set (or false positive), false if definitely not in set
   */
  mightContain(item: string): boolean {
    return this.filter.has(item);
  }

  /**
   * Get statistics about the filter
   */
  getStats(): {
    size: number;
    hashCount: number;
    itemCount: number;
    bitsSet: number;
    fillRatio: number;
    estimatedFPR: number;
  } {
    // The NPM BloomFilter has these properties
    const size = (this.filter as any)._size || this.expectedItems * 10;
    const hashCount = (this.filter as any)._nbHashes || 7;
    const bitsSet = Math.round(size * 0.5); // Estimate
    
    return {
      size,
      hashCount,
      itemCount: this.itemCount,
      bitsSet,
      fillRatio: bitsSet / size,
      estimatedFPR: this.filter.rate(),
    };
  }

  /**
   * Create a Bloom filter from a set of items
   */
  static fromSet(items: Set<string>, falsePositiveRate: number = 0.001): BloomFilter {
    // Use the NPM package's from method which is optimal for collections
    const npmFilter = NPMBloomFilter.from(Array.from(items), falsePositiveRate);
    
    // Create our wrapper
    const wrapper = Object.create(BloomFilter.prototype) as BloomFilter;
    wrapper.filter = npmFilter;
    wrapper.itemCount = items.size;
    wrapper.expectedItems = items.size;
    wrapper.falsePositiveRate = falsePositiveRate;
    
    console.log(`[BloomFilter] Created from set with ${items.size} items, ${falsePositiveRate} FPR`);
    
    return wrapper;
  }

  /**
   * Serialize the filter to a buffer for transmission
   */
  serialize(): Buffer {
    const json = this.filter.saveAsJSON();
    return Buffer.from(JSON.stringify(json));
  }

  /**
   * Deserialize a filter from a buffer
   */
  static deserialize(buffer: Buffer): BloomFilter {
    const json = JSON.parse(buffer.toString());
    const npmFilter = NPMBloomFilter.fromJSON(json);
    
    const wrapper = Object.create(BloomFilter.prototype) as BloomFilter;
    wrapper.filter = npmFilter;
    wrapper.itemCount = 0; // We don't know the exact count after deserialization
    wrapper.expectedItems = 10000; // Default
    wrapper.falsePositiveRate = 0.001; // Default
    
    return wrapper;
  }
}