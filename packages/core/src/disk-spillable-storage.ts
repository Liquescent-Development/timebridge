import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LogEvent } from './types';

interface SpillConfig {
  maxMemoryMB: number;
  spillDirectory?: string;
  compressionEnabled?: boolean;
}

/**
 * Storage that automatically spills to disk when memory limits are exceeded
 * Enables processing of datasets larger than available RAM
 */
export class DiskSpillableStorage {
  private memoryStorage = new Map<string, LogEvent[]>();
  private diskStorage = new Map<string, string>(); // key -> file path
  private currentMemoryUsage = 0;
  private spillDir: string;
  private readonly maxMemoryBytes: number;
  private spillCount = 0;

  constructor(private config: SpillConfig) {
    this.maxMemoryBytes = config.maxMemoryMB * 1024 * 1024;
    this.spillDir = config.spillDirectory || path.join(process.cwd(), '.timebridge-spill');
    
    // Ensure spill directory exists
    if (!fs.existsSync(this.spillDir)) {
      fs.mkdirSync(this.spillDir, { recursive: true });
    }
  }

  async add(key: string, event: LogEvent): Promise<void> {
    // Estimate event size (rough approximation)
    const eventSize = JSON.stringify(event).length;
    
    // Check if we need to spill
    if (this.currentMemoryUsage + eventSize > this.maxMemoryBytes) {
      await this.spillToDisk();
    }

    // Add to memory storage
    if (!this.memoryStorage.has(key)) {
      this.memoryStorage.set(key, []);
    }
    this.memoryStorage.get(key)!.push(event);
    this.currentMemoryUsage += eventSize;
  }

  async get(key: string): Promise<LogEvent[] | undefined> {
    // Check memory first
    if (this.memoryStorage.has(key)) {
      return this.memoryStorage.get(key);
    }

    // Check disk
    if (this.diskStorage.has(key)) {
      return await this.loadFromDisk(key);
    }

    return undefined;
  }

  private async spillToDisk(): Promise<void> {
    console.log(`[DiskSpillableStorage] Spilling to disk (memory: ${Math.round(this.currentMemoryUsage / 1024 / 1024)}MB)`);
    
    // Find the oldest keys to spill (simple LRU approximation)
    const keysToSpill = Array.from(this.memoryStorage.keys()).slice(0, Math.floor(this.memoryStorage.size / 2));
    
    for (const key of keysToSpill) {
      const events = this.memoryStorage.get(key)!;
      const fileName = `spill_${this.spillCount++}_${crypto.createHash('md5').update(key).digest('hex')}.json`;
      const filePath = path.join(this.spillDir, fileName);
      
      // Write to disk (could add compression here)
      await fs.promises.writeFile(filePath, JSON.stringify(events));
      
      // Update tracking
      this.diskStorage.set(key, filePath);
      this.memoryStorage.delete(key);
      this.currentMemoryUsage -= JSON.stringify(events).length;
    }

    console.log(`[DiskSpillableStorage] Spilled ${keysToSpill.length} keys to disk`);
  }

  private async loadFromDisk(key: string): Promise<LogEvent[]> {
    const filePath = this.diskStorage.get(key)!;
    const data = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  }

  async cleanup(): Promise<void> {
    // Clean up spill files
    for (const filePath of this.diskStorage.values()) {
      try {
        await fs.promises.unlink(filePath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
    // Clean up directory if empty
    try {
      await fs.promises.rmdir(this.spillDir);
    } catch (e) {
      // Directory might not be empty or might not exist
    }
  }

  getStats() {
    return {
      memoryKeys: this.memoryStorage.size,
      diskKeys: this.diskStorage.size,
      memoryUsageMB: Math.round(this.currentMemoryUsage / 1024 / 1024),
      spillCount: this.spillCount
    };
  }
}