#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { table } from 'table';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TimeQLQueryClient } from '@timebridge/core';
import { createInterface } from 'readline';

const program = new Command();

// Configure CLI
program
  .name('timeql')
  .description('TimeQL CLI for querying persisted databases')
  .version('0.0.7');

// List databases command
program
  .command('list')
  .description('List all available persisted databases')
  .option('-p, --path <path>', 'Database directory path', path.join(os.tmpdir(), 'timebridge_persist'))
  .action(async (options) => {
    const spinner = ora('Scanning for databases...').start();
    
    try {
      const client = new TimeQLQueryClient({ databasePath: options.path });
      const databases = await client.listDatabases();
      
      spinner.stop();
      
      if (databases.length === 0) {
        console.log(chalk.yellow('No databases found in ' + options.path));
        return;
      }
      
      const tableData = [
        ['Name', 'Size', 'Events', 'Created', 'Path']
      ];
      
      for (const db of databases) {
        tableData.push([
          chalk.cyan(db.name),
          formatSize(db.sizeBytes || 0),
          db.eventCount?.toLocaleString() || 'N/A',
          db.createdAt ? new Date(db.createdAt).toLocaleString() : 'N/A',
          db.path
        ]);
      }
      
      console.log(table(tableData));
      await client.close();
    } catch (error: any) {
      spinner.fail('Failed to list databases');
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

// Query command
program
  .command('query <database> <query>')
  .description('Execute a TimeQL query on a persisted database')
  .option('-p, --path <path>', 'Database directory path', path.join(os.tmpdir(), 'timebridge_persist'))
  .option('-f, --format <format>', 'Output format (json|table|csv)', 'table')
  .option('-l, --limit <limit>', 'Limit number of results', '100')
  .action(async (database, query, options) => {
    const spinner = ora(`Executing query on ${database}...`).start();
    
    try {
      const client = new TimeQLQueryClient({ 
        databasePath: options.path,
        duckdbConfig: { memoryLimit: '4GB' }
      });
      
      await client.loadDatabase(database);
      const results = await client.query(query);
      
      spinner.stop();
      
      if (results.length === 0) {
        console.log(chalk.yellow('No results found'));
        await client.close();
        return;
      }
      
      // Output results based on format
      switch (options.format) {
        case 'json':
          console.log(JSON.stringify(results, null, 2));
          break;
          
        case 'csv':
          outputCSV(results);
          break;
          
        case 'table':
        default:
          outputTable(results.slice(0, parseInt(options.limit)));
          break;
      }
      
      console.log(chalk.green(`\n✓ Found ${results.length} results`));
      await client.close();
    } catch (error: any) {
      spinner.fail('Query failed');
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

// SQL command
program
  .command('sql <database> <query>')
  .description('Execute a raw SQL query on a persisted database')
  .option('-p, --path <path>', 'Database directory path', path.join(os.tmpdir(), 'timebridge_persist'))
  .option('-f, --format <format>', 'Output format (json|table|csv)', 'table')
  .action(async (database, query, options) => {
    const spinner = ora(`Executing SQL on ${database}...`).start();
    
    try {
      const client = new TimeQLQueryClient({ 
        databasePath: options.path,
        duckdbConfig: { memoryLimit: '4GB' }
      });
      
      await client.loadDatabase(database);
      const results = await client.sql(query);
      
      spinner.stop();
      
      // Output results
      switch (options.format) {
        case 'json':
          console.log(JSON.stringify(results, null, 2));
          break;
        case 'csv':
          outputCSV(results);
          break;
        case 'table':
        default:
          outputTable(results);
          break;
      }
      
      await client.close();
    } catch (error: any) {
      spinner.fail('SQL execution failed');
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

// Info command
program
  .command('info <database>')
  .description('Show detailed information about a database')
  .option('-p, --path <path>', 'Database directory path', path.join(os.tmpdir(), 'timebridge_persist'))
  .action(async (database, options) => {
    const spinner = ora(`Loading database info...`).start();
    
    try {
      const client = new TimeQLQueryClient({ databasePath: options.path });
      await client.loadDatabase(database);
      const metadata = await client.getMetadata();
      
      spinner.stop();
      
      console.log(chalk.bold.cyan('\nDatabase Information:'));
      console.log(chalk.white('─'.repeat(50)));
      console.log(`${chalk.bold('Name:')} ${database}`);
      console.log(`${chalk.bold('Path:')} ${metadata.path}`);
      console.log(`${chalk.bold('Type:')} ${metadata.isInMemory ? 'In-Memory' : 'Persisted'}`);
      console.log(`${chalk.bold('Event Count:')} ${metadata.eventCount?.toLocaleString() || 'N/A'}`);
      
      if (metadata.sizeBytes) {
        console.log(`${chalk.bold('Size:')} ${formatSize(metadata.sizeBytes)}`);
      }
      
      if (metadata.tables && metadata.tables.length > 0) {
        console.log(`${chalk.bold('Tables:')} ${metadata.tables.join(', ')}`);
      }
      
      if (metadata.partitions && metadata.partitions.length > 0) {
        console.log(`${chalk.bold('Partitions:')} ${metadata.partitions.join(', ')}`);
      }
      
      await client.close();
    } catch (error: any) {
      spinner.fail('Failed to get database info');
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

// Export command
program
  .command('export <database> <exportPath>')
  .description('Export a database to a file')
  .option('-p, --path <path>', 'Database directory path', path.join(os.tmpdir(), 'timebridge_persist'))
  .action(async (database, exportPath, options) => {
    const spinner = ora(`Exporting ${database}...`).start();
    
    try {
      const client = new TimeQLQueryClient({ databasePath: options.path });
      await client.exportDatabase(database, exportPath);
      
      spinner.succeed(`Database exported to ${exportPath}`);
      await client.close();
    } catch (error: any) {
      spinner.fail('Export failed');
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

// Import command
program
  .command('import <importPath> [name]')
  .description('Import a database from a file')
  .option('-p, --path <path>', 'Database directory path', path.join(os.tmpdir(), 'timebridge_persist'))
  .action(async (importPath, name, options) => {
    const spinner = ora(`Importing database...`).start();
    
    try {
      const client = new TimeQLQueryClient({ databasePath: options.path });
      await client.importDatabase(importPath, name);
      
      spinner.succeed(`Database imported${name ? ' as ' + name : ''}`);
      await client.close();
    } catch (error: any) {
      spinner.fail('Import failed');
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

// Delete command
program
  .command('delete <database>')
  .description('Delete a persisted database')
  .option('-p, --path <path>', 'Database directory path', path.join(os.tmpdir(), 'timebridge_persist'))
  .option('-f, --force', 'Skip confirmation')
  .action(async (database, options) => {
    if (!options.force) {
      const answer = await new Promise<string>((resolve) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        rl.question(chalk.yellow(`Are you sure you want to delete '${database}'? (yes/no): `), (ans) => {
          rl.close();
          resolve(ans);
        });
      });
      
      if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
        console.log(chalk.gray('Deletion cancelled'));
        return;
      }
    }
    
    const spinner = ora(`Deleting ${database}...`).start();
    
    try {
      const client = new TimeQLQueryClient({ databasePath: options.path });
      await client.deleteDatabase(database);
      
      spinner.succeed(`Database '${database}' deleted`);
      await client.close();
    } catch (error: any) {
      spinner.fail('Deletion failed');
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

// REPL command
program
  .command('repl <database>')
  .description('Start an interactive REPL for the database')
  .option('-p, --path <path>', 'Database directory path', path.join(os.tmpdir(), 'timebridge_persist'))
  .action(async (database, options) => {
    console.log(chalk.cyan(`TimeQL REPL for ${database}`));
    console.log(chalk.gray('Type "exit" or Ctrl+C to quit\n'));
    
    const client = new TimeQLQueryClient({ 
      databasePath: options.path,
      duckdbConfig: { memoryLimit: '4GB' }
    });
    
    try {
      await client.loadDatabase(database);
      
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.green('timeql> ')
      });
      
      rl.prompt();
      
      rl.on('line', async (line) => {
        const query = line.trim();
        
        if (query === 'exit' || query === 'quit') {
          rl.close();
          return;
        }
        
        if (query === '') {
          rl.prompt();
          return;
        }
        
        try {
          // Determine if it's SQL or TimeQL
          const isSql = query.toUpperCase().startsWith('SELECT') || 
                       query.toUpperCase().startsWith('WITH');
          
          const results = isSql ? await client.sql(query) : await client.query(query);
          
          if (results.length === 0) {
            console.log(chalk.yellow('No results'));
          } else {
            outputTable(results.slice(0, 20));
            if (results.length > 20) {
              console.log(chalk.gray(`... and ${results.length - 20} more rows`));
            }
          }
        } catch (error: any) {
          console.error(chalk.red('Error: ' + error.message));
        }
        
        rl.prompt();
      });
      
      rl.on('close', async () => {
        console.log(chalk.gray('\nGoodbye!'));
        await client.close();
        process.exit(0);
      });
    } catch (error: any) {
      console.error(chalk.red('Failed to load database: ' + error.message));
      process.exit(1);
    }
  });

// Helper functions
function formatSize(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

function outputTable(results: any[]): void {
  if (results.length === 0) return;
  
  const keys = Object.keys(results[0]);
  const tableData = [keys];
  
  for (const row of results) {
    tableData.push(keys.map(k => {
      const value = row[k];
      if (value === null) return 'NULL';
      if (value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    }));
  }
  
  console.log(table(tableData));
}

function outputCSV(results: any[]): void {
  if (results.length === 0) return;
  
  const keys = Object.keys(results[0]);
  console.log(keys.join(','));
  
  for (const row of results) {
    const values = keys.map(k => {
      const value = row[k];
      if (value === null) return '';
      if (value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      const str = String(value);
      // Escape CSV values
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    console.log(values.join(','));
  }
}

// Parse command-line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}