import { Transform, PassThrough } from 'stream';
import * as zlib from 'zlib';

export function createCSVPassthrough(writer: NodeJS.WritableStream, logger: any) {
  return new Promise((resolve, reject) => {
    let chunksProcessed = 0;
    let bytesProcessed = 0;
    
    // Simple passthrough that just logs progress
    const progressTracker = new Transform({
      transform(chunk: Buffer, encoding: string, callback: Function) {
        chunksProcessed++;
        bytesProcessed += chunk.length;
        
        if (chunksProcessed <= 3 || chunksProcessed % 100 === 0) {
          logger.debug({ 
            chunkNumber: chunksProcessed, 
            chunkSize: chunk.length,
            totalBytes: bytesProcessed 
          }, "Processing chunk");
        }
        
        // Just pass the chunk through unchanged
        this.push(chunk);
        callback();
      },
      
      flush(callback: Function) {
        logger.info({ 
          totalChunks: chunksProcessed,
          totalBytes: bytesProcessed
        }, "CSV streaming complete");
        callback();
      }
    });
    
    return { progressTracker, resolve, reject };
  });
}