#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node generate-dashboard.js <path-to-duckdb-file> [output-file]');
  console.error('Example: node generate-dashboard.js ~/.timebridge/databases/graylog_2025-09-04.duckdb');
  process.exit(1);
}

const dbPath = args[0];
const outputFile = args[1] || `dashboard-${new Date().toISOString().split('T')[0]}.html`;

// Check if database exists
if (!fs.existsSync(dbPath)) {
  console.error(`Error: Database file not found: ${dbPath}`);
  process.exit(1);
}

console.log('📊 Generating Executive Dashboard from DuckDB');
console.log(`   ├─ Database: ${dbPath}`);
console.log(`   └─ Output: ${outputFile}`);

// Analyze correlations from DuckDB
async function analyzeDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    // Use proper DuckDB Node.js API
    const db = new duckdb.Database(dbPath, duckdb.OPEN_READONLY, (err) => {
      if (err) {
        console.error('Failed to open database:', err);
        reject(err);
        return;
      }
      
      const conn = db.connect();
      
      const analytics = {
        totalCorrelations: 0,
        totalEvents: 0,
        accountIds: new Set(),
        requestIds: new Set(),
        hostnames: new Set(),
        instanceIds: new Set(),
        eniIds: new Set(),
        vpcIds: new Set(),
        ipMappings: [],
        timeRange: { start: null, end: null },
        eventsByHour: {},
        eventsByAccount: {},
        eventsByHostname: {},
        eventsByInstanceId: {},
        eventsByEni: {},
        eventsByVpc: {},
        errorPatterns: [],
        topAccounts: [],
        topHostnames: [],
        topInstances: [],
        topEnis: [],
        topVpcs: [],
        correlationSizes: { small: 0, medium: 0, large: 0 },
        timelineData: [],
        topErrors: [],
        hourlyDistribution: [],
        networkIssues: {
          transmitFailures: 0,
          dnsFailures: 0,
          vpcIssues: 0,
          interfaceErrors: 0
        }
      };

      // Check table schema first
      conn.all("SELECT column_name FROM information_schema.columns WHERE table_name = 'events' AND table_schema = 'main'", (err, columns) => {
        if (err) {
          console.error('Error checking table schema:', err);
          db.close();
          reject(err);
          return;
        }
        
        const columnNames = columns.map(c => c.column_name);
        console.log('\nDetected columns:', columnNames.join(', '));
        
        const hasRequestId = columnNames.includes('request_id');
        const hasAccountId = columnNames.includes('account_id'); 
        const hasMessage = columnNames.includes('message');
        const hasTimestamp = columnNames.includes('timestamp');
        const hasLabels = columnNames.includes('labels');
        
        // Build queries based on available columns
        runQueries(conn, db, analytics, {
          hasRequestId,
          hasAccountId,
          hasMessage,
          hasTimestamp,
          hasLabels
        }).then(() => {
          db.close((err) => {
            if (err) console.error('Error closing database:', err);
            resolve(analytics);
          });
        }).catch(err => {
          db.close();
          reject(err);
        });
      });
    });
  });
}

// Run all queries
async function runQueries(conn, db, analytics, schema) {
  return new Promise((resolve, reject) => {
    // Query 1: Get overall statistics
    const statsQuery = schema.hasRequestId ? `
      SELECT 
        COUNT(DISTINCT request_id) as unique_requests,
        COUNT(*) as total_events,
        MIN(timestamp) as min_time,
        MAX(timestamp) as max_time
      FROM events
      WHERE request_id IS NOT NULL
    ` : `
      SELECT 
        0 as unique_requests,
        COUNT(*) as total_events,
        MIN(timestamp) as min_time,
        MAX(timestamp) as max_time
      FROM events
    `;
    
    conn.all(statsQuery, (err, result) => {
      if (err) {
        console.error('Error querying statistics:', err);
        reject(err);
        return;
      }
      
      if (result && result[0]) {
        // Convert BigInt to Number for counts
        analytics.totalCorrelations = Number(result[0].unique_requests || 0);
        analytics.totalEvents = Number(result[0].total_events || 0);
        // Ensure UTC timestamps
        analytics.timeRange.start = result[0].min_time ? new Date(String(result[0].min_time) + (String(result[0].min_time).includes('Z') ? '' : 'Z')) : new Date();
        analytics.timeRange.end = result[0].max_time ? new Date(String(result[0].max_time) + (String(result[0].max_time).includes('Z') ? '' : 'Z')) : new Date();
      }

      // Query 2: Get events by account
      // Check if account_id exists as a column or needs to be extracted from labels
      let accountQuery;
      if (schema.hasAccountId) {
        accountQuery = `
          SELECT 
            account_id,
            COUNT(*) as event_count
          FROM events
          WHERE account_id IS NOT NULL AND account_id != ''
          GROUP BY account_id
          ORDER BY event_count DESC
          LIMIT 20
        `;
      } else if (schema.hasLabels) {
        // Extract account_id from JSON labels
        accountQuery = `
          SELECT 
            json_extract_string(labels, '$.account_id') as account_id,
            COUNT(*) as event_count
          FROM events
          WHERE json_extract_string(labels, '$.account_id') IS NOT NULL 
            AND json_extract_string(labels, '$.account_id') != ''
          GROUP BY json_extract_string(labels, '$.account_id')
          ORDER BY event_count DESC
          LIMIT 20
        `;
      } else {
        accountQuery = null;
      }
      
      if (accountQuery) {
        conn.all(accountQuery, (err, accountResults) => {
          if (!err && accountResults) {
            accountResults.forEach(row => {
              if (row.account_id && row.account_id !== '') {
                analytics.accountIds.add(row.account_id);
                analytics.eventsByAccount[row.account_id] = Number(row.event_count || 0);
              }
            });
            
            analytics.topAccounts = accountResults
              .filter(r => r.account_id && r.account_id !== '')
              .slice(0, 10)
              .map(r => ({ account: r.account_id, count: Number(r.event_count || 0) }));
          }
          
          continueQueries2();
        });
      } else {
        continueQueries2();
      }
      
      function continueQueries2() {
        // Query 2.5: Get events by hostname
        if (schema.hasLabels) {
          conn.all(`
            SELECT 
              json_extract_string(labels, '$.hostname') as hostname,
              COUNT(*) as event_count
            FROM events
            WHERE json_extract_string(labels, '$.hostname') IS NOT NULL 
              AND json_extract_string(labels, '$.hostname') != ''
            GROUP BY json_extract_string(labels, '$.hostname')
            ORDER BY event_count DESC
            LIMIT 20
          `, (err, hostnameResults) => {
            if (!err && hostnameResults) {
              hostnameResults.forEach(row => {
                if (row.hostname && row.hostname !== '') {
                  analytics.hostnames.add(row.hostname);
                  analytics.eventsByHostname[row.hostname] = Number(row.event_count || 0);
                }
              });
              
              analytics.topHostnames = hostnameResults
                .filter(r => r.hostname && r.hostname !== '')
                .slice(0, 10)
                .map(r => ({ hostname: r.hostname, count: Number(r.event_count || 0) }));
            }
            
            continueQueries();
          });
        } else {
          continueQueries();
        }
      }

      function continueQueries() {
        // Query 3: Get hourly distribution
        conn.all(`
          SELECT 
            DATE_TRUNC('hour', timestamp) as hour,
            COUNT(*) as event_count
          FROM events
          GROUP BY DATE_TRUNC('hour', timestamp)
          ORDER BY hour
          LIMIT 100
        `, (err, hourlyResults) => {
          if (!err && hourlyResults) {
            hourlyResults.forEach(row => {
              // Ensure UTC handling
              const hourStr = String(row.hour || '');
              const hour = row.hour ? new Date(hourStr + (hourStr.includes('Z') || hourStr.includes('+') || hourStr.includes('-') ? '' : 'Z')).toISOString() : new Date().toISOString();
              analytics.eventsByHour[hour] = Number(row.event_count || 0);
              analytics.hourlyDistribution.push({
                hour: hour,
                count: Number(row.event_count || 0)
              });
            });
          }

          // Query 4: Analyze error patterns (if message column exists)
          if (schema.hasMessage) {
            let errorQuery;
            if (schema.hasAccountId) {
              errorQuery = `
                SELECT 
                  message,
                  COUNT(*) as occurrences,
                  account_id,
                  MIN(timestamp) as first_seen,
                  MAX(timestamp) as last_seen
                FROM events
                WHERE message LIKE '%failed%' 
                   OR message LIKE '%error%'
                   OR message LIKE '%failure%'
                GROUP BY message, account_id
                ORDER BY occurrences DESC
                LIMIT 100
              `;
            } else if (schema.hasLabels) {
              errorQuery = `
                SELECT 
                  message,
                  COUNT(*) as occurrences,
                  json_extract_string(labels, '$.account_id') as account_id,
                  MIN(timestamp) as first_seen,
                  MAX(timestamp) as last_seen
                FROM events
                WHERE message LIKE '%failed%' 
                   OR message LIKE '%error%'
                   OR message LIKE '%failure%'
                GROUP BY message, json_extract_string(labels, '$.account_id')
                ORDER BY occurrences DESC
                LIMIT 100
              `;
            } else {
              errorQuery = `
                SELECT 
                  message,
                  COUNT(*) as occurrences,
                  MIN(timestamp) as first_seen,
                  MAX(timestamp) as last_seen
                FROM events
                WHERE message LIKE '%failed%' 
                   OR message LIKE '%error%'
                   OR message LIKE '%failure%'
                GROUP BY message
                ORDER BY occurrences DESC
                LIMIT 100
              `;
            }
            
            conn.all(errorQuery, (err, errorResults) => {
              if (!err && errorResults) {
                errorResults.forEach(row => {
                  const message = String(row.message || '');
                  const occurrences = Number(row.occurrences || 0);
                  
                  // Categorize errors
                  if (message.includes('failed to transmit')) {
                    analytics.networkIssues.transmitFailures += occurrences;
                  }
                  if (message.includes('DNS')) {
                    analytics.networkIssues.dnsFailures += occurrences;
                  }
                  if (message.includes('VPC') || message.includes('vpc')) {
                    analytics.networkIssues.vpcIssues += occurrences;
                  }
                  if (message.includes('NetworkInterface')) {
                    analytics.networkIssues.interfaceErrors += occurrences;
                  }
                  
                  analytics.errorPatterns.push({
                    pattern: detectErrorPattern(message),
                    message: message.substring(0, 200),
                    occurrences: occurrences,
                    accountId: row.account_id || 'unknown',
                    firstSeen: row.first_seen ? String(row.first_seen) : null,
                    lastSeen: row.last_seen ? String(row.last_seen) : null
                  });
                });
                
                analytics.topErrors = analytics.errorPatterns
                  .sort((a, b) => b.occurrences - a.occurrences)
                  .slice(0, 10);
              }
              
              // Query 4.5: Extract AWS Resource IDs from messages
              conn.all(`
                SELECT 
                  message,
                  COUNT(*) as occurrences
                FROM events
                WHERE message LIKE '%i-0%' 
                   OR message LIKE '%eni-0%'
                   OR message LIKE '%vpc-0%'
                   OR message LIKE '%HostIp:%'
                GROUP BY message
                LIMIT 5000
              `, (err, resourceResults) => {
                if (!err && resourceResults) {
                  // Regex patterns for AWS resources
                  const instancePattern = /\b(i-[0-9a-f]{8,17})\b/g;
                  const eniPattern = /\b(eni-[0-9a-f]{8,17})\b/g;
                  const vpcPattern = /\b(vpc-[0-9a-f]{8,17})\b/g;
                  const ipMappingPattern = /HostIp:([\d.]+).*?NetworkInterfaceId:(eni-[0-9a-f]{8,17}).*?PrivateIpAddress:([\d.]+).*?InstanceId:(i-[0-9a-f]{8,17})/g;
                  
                  resourceResults.forEach(row => {
                    const message = String(row.message || '');
                    const count = Number(row.occurrences || 0);
                    
                    // Extract instance IDs
                    const instances = message.match(instancePattern);
                    if (instances) {
                      instances.forEach(instanceId => {
                        analytics.instanceIds.add(instanceId);
                        analytics.eventsByInstanceId[instanceId] = (analytics.eventsByInstanceId[instanceId] || 0) + count;
                      });
                    }
                    
                    // Extract ENI IDs
                    const enis = message.match(eniPattern);
                    if (enis) {
                      enis.forEach(eniId => {
                        analytics.eniIds.add(eniId);
                        analytics.eventsByEni[eniId] = (analytics.eventsByEni[eniId] || 0) + count;
                      });
                    }
                    
                    // Extract VPC IDs
                    const vpcs = message.match(vpcPattern);
                    if (vpcs) {
                      vpcs.forEach(vpcId => {
                        analytics.vpcIds.add(vpcId);
                        analytics.eventsByVpc[vpcId] = (analytics.eventsByVpc[vpcId] || 0) + count;
                      });
                    }
                    
                    // Extract IP mappings
                    let match;
                    ipMappingPattern.lastIndex = 0; // Reset regex
                    while ((match = ipMappingPattern.exec(message)) !== null) {
                      analytics.ipMappings.push({
                        hostIp: match[1],
                        eniId: match[2],
                        privateIp: match[3],
                        instanceId: match[4],
                        occurrences: count
                      });
                    }
                  });
                  
                  // Create top lists
                  analytics.topInstances = Object.entries(analytics.eventsByInstanceId)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
                    .map(([id, count]) => ({ instanceId: id, count }));
                  
                  analytics.topEnis = Object.entries(analytics.eventsByEni)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
                    .map(([id, count]) => ({ eniId: id, count }));
                  
                  analytics.topVpcs = Object.entries(analytics.eventsByVpc)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
                    .map(([id, count]) => ({ vpcId: id, count }));
                }
                
                finalQuery();
              });
            });
          } else {
            // Query 4.5: Extract AWS Resource IDs from messages
            conn.all(`
              SELECT 
                message,
                COUNT(*) as occurrences
              FROM events
              WHERE message LIKE '%i-0%' 
                 OR message LIKE '%eni-0%'
                 OR message LIKE '%vpc-0%'
                 OR message LIKE '%HostIp:%'
              GROUP BY message
              LIMIT 5000
            `, (err, resourceResults) => {
              if (!err && resourceResults) {
                // Regex patterns for AWS resources
                const instancePattern = /\b(i-[0-9a-f]{8,17})\b/g;
                const eniPattern = /\b(eni-[0-9a-f]{8,17})\b/g;
                const vpcPattern = /\b(vpc-[0-9a-f]{8,17})\b/g;
                const ipMappingPattern = /HostIp:([\d.]+).*?NetworkInterfaceId:(eni-[0-9a-f]{8,17}).*?PrivateIpAddress:([\d.]+).*?InstanceId:(i-[0-9a-f]{8,17})/g;
                
                resourceResults.forEach(row => {
                  const message = String(row.message || '');
                  const count = Number(row.occurrences || 0);
                  
                  // Extract instance IDs
                  const instances = message.match(instancePattern);
                  if (instances) {
                    instances.forEach(instanceId => {
                      analytics.instanceIds.add(instanceId);
                      analytics.eventsByInstanceId[instanceId] = (analytics.eventsByInstanceId[instanceId] || 0) + count;
                    });
                  }
                  
                  // Extract ENI IDs
                  const enis = message.match(eniPattern);
                  if (enis) {
                    enis.forEach(eniId => {
                      analytics.eniIds.add(eniId);
                      analytics.eventsByEni[eniId] = (analytics.eventsByEni[eniId] || 0) + count;
                    });
                  }
                  
                  // Extract VPC IDs
                  const vpcs = message.match(vpcPattern);
                  if (vpcs) {
                    vpcs.forEach(vpcId => {
                      analytics.vpcIds.add(vpcId);
                      analytics.eventsByVpc[vpcId] = (analytics.eventsByVpc[vpcId] || 0) + count;
                    });
                  }
                  
                  // Extract IP mappings
                  let match;
                  ipMappingPattern.lastIndex = 0; // Reset regex
                  while ((match = ipMappingPattern.exec(message)) !== null) {
                    analytics.ipMappings.push({
                      hostIp: match[1],
                      eniId: match[2],
                      privateIp: match[3],
                      instanceId: match[4],
                      occurrences: count
                    });
                  }
                });
                
                // Create top lists
                analytics.topInstances = Object.entries(analytics.eventsByInstanceId)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 10)
                  .map(([id, count]) => ({ instanceId: id, count }));
                
                analytics.topEnis = Object.entries(analytics.eventsByEni)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 10)
                  .map(([id, count]) => ({ eniId: id, count }));
                
                analytics.topVpcs = Object.entries(analytics.eventsByVpc)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 10)
                  .map(([id, count]) => ({ vpcId: id, count }));
              }
              
              finalQuery();
            });
          }
          
          function finalQuery() {
            // Query 5: Get correlation sizes (if request_id exists)
            if (schema.hasRequestId) {
              let correlationQuery;
              if (schema.hasAccountId) {
                correlationQuery = `
                  SELECT 
                    request_id,
                    COUNT(*) as event_count,
                    MIN(timestamp) as start_time,
                    MAX(timestamp) as end_time,
                    MAX(account_id) as account_id
                  FROM events
                  WHERE request_id IS NOT NULL
                  GROUP BY request_id
                  ORDER BY event_count DESC
                  LIMIT 1000
                `;
              } else if (schema.hasLabels) {
                correlationQuery = `
                  SELECT 
                    request_id,
                    COUNT(*) as event_count,
                    MIN(timestamp) as start_time,
                    MAX(timestamp) as end_time,
                    MAX(json_extract_string(labels, '$.account_id')) as account_id,
                    MAX(json_extract_string(labels, '$.hostname')) as hostname
                  FROM events
                  WHERE request_id IS NOT NULL
                  GROUP BY request_id
                  ORDER BY event_count DESC
                  LIMIT 1000
                `;
              } else {
                correlationQuery = `
                  SELECT 
                    request_id,
                    COUNT(*) as event_count,
                    MIN(timestamp) as start_time,
                    MAX(timestamp) as end_time
                  FROM events
                  WHERE request_id IS NOT NULL
                  GROUP BY request_id
                  ORDER BY event_count DESC
                  LIMIT 1000
                `;
              }
              
              conn.all(correlationQuery, (err, correlationResults) => {
                if (!err && correlationResults) {
                  correlationResults.forEach(row => {
                    if (row.request_id) {
                      analytics.requestIds.add(row.request_id);
                      
                      // Categorize by size
                      const eventCount = Number(row.event_count || 0);
                      if (eventCount <= 5) {
                        analytics.correlationSizes.small++;
                      } else if (eventCount <= 20) {
                        analytics.correlationSizes.medium++;
                      } else {
                        analytics.correlationSizes.large++;
                      }
                      
                      // Add to timeline (limit for performance)
                      if (analytics.timelineData.length < 100) {
                        // Ensure timestamps are properly formatted for timeline
                        const startStr = String(row.start_time || '');
                        const endStr = String(row.end_time || '');
                        analytics.timelineData.push({
                          requestId: row.request_id,
                          startTime: new Date(startStr + (startStr.includes('Z') || startStr.includes('+') || startStr.includes('-') ? '' : 'Z')).toISOString(),
                          endTime: new Date(endStr + (endStr.includes('Z') || endStr.includes('+') || endStr.includes('-') ? '' : 'Z')).toISOString(),
                          eventCount: Number(row.event_count || 0),
                          accountId: row.account_id || 'unknown'
                        });
                      }
                    }
                  });
                }
                
                resolve();
              });
            } else {
              resolve();
            }
          }
        });
      }
    });
  });
}

// Detect error pattern from message
function detectErrorPattern(message) {
  if (message.includes('failed to transmit')) return 'Network Transmission Failure';
  if (message.includes('DNS')) return 'DNS Resolution Issue';
  if (message.includes('VPC') || message.includes('vpc')) return 'VPC Connectivity Problem';
  if (message.includes('NetworkInterface')) return 'Network Interface Error';
  if (message.includes('timeout')) return 'Timeout Error';
  if (message.includes('connection')) return 'Connection Error';
  if (message.includes('authentication') || message.includes('auth')) return 'Authentication Issue';
  if (message.includes('permission') || message.includes('denied')) return 'Permission Error';
  return 'General Error';
}

// Generate HTML dashboard
function generateDashboard(analytics, metadata) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Correlation Analysis Dashboard - DuckDB Analysis</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #1e3c72, #2a5298);
      color: #fff;
      min-height: 100vh;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    
    header {
      text-align: center;
      padding: 40px 0;
      background: rgba(255,255,255,0.1);
      border-radius: 10px;
      margin-bottom: 30px;
      backdrop-filter: blur(10px);
    }
    h1 { font-size: 2.5rem; margin-bottom: 10px; }
    .subtitle { 
      color: #a0c4ff; 
      font-size: 1.1rem; 
      margin-bottom: 20px;
    }
    
    .metadata {
      display: flex;
      justify-content: center;
      gap: 30px;
      flex-wrap: wrap;
    }
    .metadata-item {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(255,255,255,0.1);
      padding: 8px 16px;
      border-radius: 20px;
    }
    
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    
    .metric-card {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      padding: 20px;
      border-radius: 10px;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.2);
      transition: transform 0.3s, box-shadow 0.3s;
    }
    .metric-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 10px 30px rgba(0,0,0,0.3);
    }
    .metric-label {
      font-size: 0.9rem;
      color: #a0c4ff;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .metric-value {
      font-size: 2rem;
      font-weight: bold;
      color: #fff;
    }
    .metric-icon {
      font-size: 2.5rem;
      margin-bottom: 10px;
    }
    
    .chart-section {
      background: rgba(255,255,255,0.95);
      padding: 30px;
      border-radius: 10px;
      margin-bottom: 30px;
      color: #333;
    }
    .chart-title {
      font-size: 1.5rem;
      margin-bottom: 20px;
      color: #2a5298;
      border-bottom: 2px solid #2a5298;
      padding-bottom: 10px;
    }
    
    .chart-container {
      position: relative;
      height: 400px;
      margin-bottom: 30px;
    }
    
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    
    .grid-3 {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
    }
    
    .error-list {
      background: rgba(255,50,50,0.1);
      border: 1px solid rgba(255,50,50,0.3);
      border-radius: 8px;
      padding: 15px;
      margin-top: 20px;
    }
    .error-item {
      padding: 10px;
      margin: 5px 0;
      background: rgba(255,255,255,0.05);
      border-radius: 5px;
      border-left: 3px solid #ff6b6b;
    }
    
    .insights {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      padding: 30px;
      border-radius: 10px;
      margin: 30px 0;
    }
    .insights h2 {
      color: #ffd700;
      margin-bottom: 20px;
      font-size: 1.8rem;
    }
    .insights ul {
      list-style: none;
      padding: 0;
    }
    .insights li {
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      font-size: 1.1rem;
    }
    
    @media (max-width: 768px) {
      .grid-2 { grid-template-columns: 1fr; }
      .grid-3 { grid-template-columns: 1fr; }
      .metrics-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔍 Correlation Analysis Dashboard</h1>
      <p class="subtitle">DuckDB Database Analysis Report</p>
      <div class="metadata">
        <div class="metadata-item">
          📁 <strong>Database:</strong> ${metadata.dbPath.split('/').pop()}
        </div>
        <div class="metadata-item">
          ⏱️ <strong>Analysis Time:</strong> ${metadata.elapsed}
        </div>
        <div class="metadata-item">
          📅 <strong>Generated:</strong> ${new Date().toLocaleString()}
        </div>
      </div>
    </header>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-icon">📊</div>
        <div class="metric-label">Total Events</div>
        <div class="metric-value">${analytics.totalEvents.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">🔗</div>
        <div class="metric-label">Correlations</div>
        <div class="metric-value">${analytics.totalCorrelations.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">👥</div>
        <div class="metric-label">Accounts</div>
        <div class="metric-value">${analytics.accountIds.size.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">🖥️</div>
        <div class="metric-label">Hosts</div>
        <div class="metric-value">${analytics.hostnames.size.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">☁️</div>
        <div class="metric-label">EC2 Instances</div>
        <div class="metric-value">${analytics.instanceIds.size.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">🌐</div>
        <div class="metric-label">ENIs</div>
        <div class="metric-value">${analytics.eniIds.size.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">🏛️</div>
        <div class="metric-label">VPCs</div>
        <div class="metric-value">${analytics.vpcIds.size.toLocaleString()}</div>
      </div>
      <div class="metric-card">
        <div class="metric-icon">⚠️</div>
        <div class="metric-label">Error Events</div>
        <div class="metric-value">${analytics.errorPatterns.reduce((sum, e) => sum + e.occurrences, 0).toLocaleString()}</div>
      </div>
    </div>

    ${analytics.hourlyDistribution.length > 0 ? `
    <div class="chart-section">
      <h2 class="chart-title">📈 Event Volume Over Time</h2>
      <div class="chart-container">
        <canvas id="timelineChart"></canvas>
      </div>
    </div>
    ` : ''}

    ${analytics.topAccounts.length > 0 ? `
    <div class="chart-section">
      <h2 class="chart-title">👥 Top 10 Accounts by Activity</h2>
      <p style="color: #666; margin: 5px 0 15px 0; font-size: 0.9rem;">Charts show only the 10 most active accounts.</p>
      <div class="grid-2">
        <div class="chart-container">
          <canvas id="accountChart"></canvas>
        </div>
        <div class="chart-container">
          <canvas id="accountPieChart"></canvas>
        </div>
      </div>
    </div>
    ` : ''}

    ${analytics.topHostnames.length > 0 ? `
    <div class="chart-section">
      <h2 class="chart-title">🖥️ Top 10 Hosts by Activity</h2>
      <p style="color: #666; margin: 5px 0 15px 0; font-size: 0.9rem;">Charts show only the 10 most active hosts. See "Complete List of All Impacted Resources" section for ALL hosts.</p>
      <div class="grid-2">
        <div class="chart-container">
          <canvas id="hostnameChart"></canvas>
        </div>
        <div class="chart-container">
          <canvas id="hostnamePieChart"></canvas>
        </div>
      </div>
    </div>
    ` : ''}

    ${analytics.topInstances.length > 0 || analytics.topEnis.length > 0 || analytics.topVpcs.length > 0 ? `
    <div class="chart-section">
      <h2 class="chart-title">☁️ Top 10 Cloud Components by Activity</h2>
      <p style="color: #666; margin: 5px 0 15px 0; font-size: 0.9rem;">Charts show only the 10 most active of each type. See "Complete List of All Impacted Resources" section below for EVERY resource ID.</p>
      <div class="grid-3">
        ${analytics.topInstances.length > 0 ? `
        <div class="chart-container">
          <h3 style="color: #2a5298; font-size: 1.1rem; margin-bottom: 10px;">Top 10 Instances</h3>
          <canvas id="instanceChart"></canvas>
        </div>
        ` : ''}
        ${analytics.topEnis.length > 0 ? `
        <div class="chart-container">
          <h3 style="color: #2a5298; font-size: 1.1rem; margin-bottom: 10px;">Top 10 Network Interfaces</h3>
          <canvas id="eniChart"></canvas>
        </div>
        ` : ''}
        ${analytics.topVpcs.length > 0 ? `
        <div class="chart-container">
          <h3 style="color: #2a5298; font-size: 1.1rem; margin-bottom: 10px;">Top 10 VPCs</h3>
          <canvas id="vpcChart"></canvas>
        </div>
        ` : ''}
      </div>
    </div>
    ` : ''}

    ${analytics.ipMappings.length > 0 ? `
    <div class="chart-section">
      <h2 class="chart-title">🌐 Network Topology Insights</h2>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
          <thead>
            <tr style="background: rgba(42, 82, 152, 0.1); border-bottom: 2px solid #2a5298;">
              <th style="padding: 10px; text-align: left;">Instance ID</th>
              <th style="padding: 10px; text-align: left;">ENI ID</th>
              <th style="padding: 10px; text-align: left;">Host IP</th>
              <th style="padding: 10px; text-align: left;">Private IP</th>
              <th style="padding: 10px; text-align: left;">Events</th>
            </tr>
          </thead>
          <tbody>
            ${analytics.ipMappings.slice(0, 20).map((mapping) => `
            <tr style="border-bottom: 1px solid rgba(200, 200, 200, 0.2);">
              <td style="padding: 8px; font-family: monospace; font-size: 0.85rem;">${mapping.instanceId}</td>
              <td style="padding: 8px; font-family: monospace; font-size: 0.85rem;">${mapping.eniId}</td>
              <td style="padding: 8px; font-family: monospace;">${mapping.hostIp}</td>
              <td style="padding: 8px; font-family: monospace;">${mapping.privateIp}</td>
              <td style="padding: 8px;">${mapping.occurrences.toLocaleString()}</td>
            </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    ${analytics.correlationSizes.small > 0 || analytics.correlationSizes.medium > 0 || analytics.correlationSizes.large > 0 ? `
    <div class="chart-section">
      <h2 class="chart-title">📊 Correlation Size Distribution</h2>
      <div class="chart-container">
        <canvas id="correlationSizeChart"></canvas>
      </div>
    </div>
    ` : ''}

    ${analytics.networkIssues.transmitFailures > 0 || analytics.networkIssues.dnsFailures > 0 ? `
    <div class="chart-section">
      <h2 class="chart-title">🌐 Network Issues Breakdown</h2>
      <div class="chart-container">
        <canvas id="networkChart"></canvas>
      </div>
    </div>
    ` : ''}
    
    ${(analytics.hostnames.size > 0 || analytics.instanceIds.size > 0 || analytics.eniIds.size > 0 || analytics.vpcIds.size > 0 || analytics.ipMappings.length > 0) ? `
    <div class="chart-section">
      <h2 class="chart-title">🔍 Complete List of All Impacted Resources</h2>
      <p style="color: #666; margin: 10px 0; font-size: 1rem;"><strong>Important:</strong> This section shows EVERY unique resource ID found in the analyzed logs, not just the top 10 shown in the charts above.</p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; margin-top: 20px;">
        
        ${analytics.hostnames.size > 0 ? `
        <div style="background: rgba(42, 82, 152, 0.05); border-radius: 8px; padding: 15px; border: 1px solid rgba(42, 82, 152, 0.2);">
          <h3 style="color: #2a5298; font-size: 1.2rem; margin-bottom: 10px;">🖥️ All Unique Hosts (${analytics.hostnames.size} total)</h3>
          <div style="max-height: 300px; overflow-y: auto; background: white; border: 1px solid #ddd; border-radius: 4px; padding: 10px;">
            ${Array.from(analytics.hostnames).sort().map((host, idx) => `
              <div style="padding: 4px 8px; margin: 2px 0; background: ${idx % 2 === 0 ? '#f8f9fa' : 'white'}; border-radius: 3px; font-family: monospace; font-size: 0.85rem; color: #333;">${idx + 1}. ${host}</div>
            `).join('')}
          </div>
        </div>
        ` : ''}
        
        ${analytics.instanceIds.size > 0 ? `
        <div style="background: rgba(255, 193, 7, 0.05); border-radius: 8px; padding: 15px; border: 1px solid rgba(255, 193, 7, 0.2);">
          <h3 style="color: #2a5298; font-size: 1.2rem; margin-bottom: 10px;">☁️ All Unique Instance IDs (${analytics.instanceIds.size} total)</h3>
          <div style="max-height: 300px; overflow-y: auto; background: white; border: 1px solid #ddd; border-radius: 4px; padding: 10px;">
            ${Array.from(analytics.instanceIds).sort().map((instanceId, idx) => `
              <div style="padding: 4px 8px; margin: 2px 0; background: ${idx % 2 === 0 ? '#fffef5' : 'white'}; border-radius: 3px; font-family: monospace; font-size: 0.85rem; color: #333;">${idx + 1}. ${instanceId}</div>
            `).join('')}
          </div>
        </div>
        ` : ''}
        
        ${analytics.eniIds.size > 0 ? `
        <div style="background: rgba(46, 204, 113, 0.05); border-radius: 8px; padding: 15px; border: 1px solid rgba(46, 204, 113, 0.2);">
          <h3 style="color: #2a5298; font-size: 1.2rem; margin-bottom: 10px;">🌐 All Unique Network Interface IDs (${analytics.eniIds.size} total)</h3>
          <div style="max-height: 300px; overflow-y: auto; background: white; border: 1px solid #ddd; border-radius: 4px; padding: 10px;">
            ${Array.from(analytics.eniIds).sort().map((eniId, idx) => `
              <div style="padding: 4px 8px; margin: 2px 0; background: ${idx % 2 === 0 ? '#f5fff8' : 'white'}; border-radius: 3px; font-family: monospace; font-size: 0.85rem; color: #333;">${idx + 1}. ${eniId}</div>
            `).join('')}
          </div>
        </div>
        ` : ''}
        
        ${analytics.vpcIds.size > 0 ? `
        <div style="background: rgba(155, 89, 182, 0.05); border-radius: 8px; padding: 15px; border: 1px solid rgba(155, 89, 182, 0.2);">
          <h3 style="color: #2a5298; font-size: 1.2rem; margin-bottom: 10px;">🏛️ All Unique VPC IDs (${analytics.vpcIds.size} total)</h3>
          <div style="max-height: 300px; overflow-y: auto; background: white; border: 1px solid #ddd; border-radius: 4px; padding: 10px;">
            ${Array.from(analytics.vpcIds).sort().map((vpcId, idx) => `
              <div style="padding: 4px 8px; margin: 2px 0; background: ${idx % 2 === 0 ? '#faf5ff' : 'white'}; border-radius: 3px; font-family: monospace; font-size: 0.85rem; color: #333;">${idx + 1}. ${vpcId}</div>
            `).join('')}
          </div>
        </div>
        ` : ''}
        
        ${analytics.ipMappings.length > 0 ? `
        <div style="background: rgba(52, 152, 219, 0.05); border-radius: 8px; padding: 15px; border: 1px solid rgba(52, 152, 219, 0.2);">
          <h3 style="color: #2a5298; font-size: 1.2rem; margin-bottom: 10px;">🌍 All Unique IP Addresses</h3>
          <div style="max-height: 300px; overflow-y: auto; background: white; border: 1px solid #ddd; border-radius: 4px; padding: 10px;">
            ${(() => {
              const hostIps = new Set();
              const privateIps = new Set();
              analytics.ipMappings.forEach(m => {
                if (m.hostIp) hostIps.add(m.hostIp);
                if (m.privateIp) privateIps.add(m.privateIp);
              });
              let html = '';
              let idx = 0;
              if (hostIps.size > 0) {
                html += '<div style="margin-bottom: 10px;"><strong style="color: #2a5298;">Host IPs (' + hostIps.size + '):</strong></div>';
                Array.from(hostIps).sort().forEach((ip) => {
                  html += '<div style="padding: 4px 8px; margin: 2px 0 2px 20px; background: ' + (idx % 2 === 0 ? '#f5faff' : 'white') + '; border-radius: 3px; font-family: monospace; font-size: 0.85rem; color: #333;">' + (idx + 1) + '. ' + ip + '</div>';
                  idx++;
                });
              }
              if (privateIps.size > 0) {
                idx = 0;
                html += '<div style="margin: 15px 0 10px 0;"><strong style="color: #2a5298;">Private IPs (' + privateIps.size + '):</strong></div>';
                Array.from(privateIps).sort().forEach((ip) => {
                  html += '<div style="padding: 4px 8px; margin: 2px 0 2px 20px; background: ' + (idx % 2 === 0 ? '#f5faff' : 'white') + '; border-radius: 3px; font-family: monospace; font-size: 0.85rem; color: #333;">' + (idx + 1) + '. ' + ip + '</div>';
                  idx++;
                });
              }
              return html;
            })()}
          </div>
        </div>
        ` : ''}
        
      </div>
    </div>
    ` : ''}

    ${analytics.topErrors.length > 0 ? `
    <div class="chart-section">
      <h2 class="chart-title">⚠️ Top Error Patterns</h2>
      <div class="error-list">
        ${analytics.topErrors.slice(0, 5).map((error, i) => `
          <div class="error-item">
            <strong>#${i + 1}</strong> ${error.pattern} - 
            <span style="color: #ff6b6b;">${error.occurrences.toLocaleString()} occurrences</span>
            ${error.accountId !== 'unknown' ? `<br><small>Account: ${error.accountId}</small>` : ''}
            <br><small style="opacity: 0.7;">${error.message}</small>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    ${analytics.timelineData.length > 0 ? `
    <div class="chart-section">
      <h2 class="chart-title">📈 Request Correlation Timeline</h2>
      <p style="color: #666; margin: 10px 0;">Each line represents a correlated request showing its duration. Hover for details. Times shown in UTC.</p>
      <div id="ganttChart" style="height: 600px;"></div>
    </div>
    ` : ''}

    <div class="insights">
      <h2>💡 Key Insights</h2>
      <ul>
        <li>📊 Processed <strong>${analytics.totalEvents.toLocaleString()}</strong> events across <strong>${analytics.totalCorrelations.toLocaleString()}</strong> correlation groups</li>
        <li>👥 <strong>${analytics.accountIds.size.toLocaleString()}</strong> customer accounts with logged activity</li>
        <li>🖥️ <strong>${analytics.hostnames.size.toLocaleString()}</strong> hosts generated events</li>
        ${analytics.instanceIds.size > 0 ? `<li>☁️ <strong>${analytics.instanceIds.size.toLocaleString()}</strong> cloud instances involved</li>` : ''}
        ${analytics.eniIds.size > 0 ? `<li>🌐 <strong>${analytics.eniIds.size.toLocaleString()}</strong> network interfaces detected</li>` : ''}
        ${analytics.vpcIds.size > 0 ? `<li>🏛️ <strong>${analytics.vpcIds.size.toLocaleString()}</strong> VPCs identified</li>` : ''}
        ${analytics.timeRange.start ? `<li>⏰ Data spans from <strong>${analytics.timeRange.start.toLocaleString('en-US', {timeZone: 'UTC'})} UTC</strong> to <strong>${analytics.timeRange.end.toLocaleString('en-US', {timeZone: 'UTC'})} UTC</strong></li>` : ''}
        ${analytics.errorPatterns.length > 0 ? `<li>⚠️ Detected <strong>${analytics.errorPatterns.length}</strong> unique error patterns affecting operations</li>` : ''}
        ${analytics.networkIssues.transmitFailures > 0 ? `<li>🌐 Network transmission failures: <strong>${analytics.networkIssues.transmitFailures.toLocaleString()}</strong> occurrences</li>` : ''}
        ${analytics.correlationSizes.large > 0 ? `<li>🔥 <strong>${analytics.correlationSizes.large}</strong> high-activity correlations with 20+ events each</li>` : ''}
      </ul>
    </div>
  </div>

  <script>
    const chartColors = {
      primary: 'rgba(42, 82, 152, 0.8)',
      secondary: 'rgba(255, 107, 107, 0.8)',
      success: 'rgba(46, 204, 113, 0.8)',
      warning: 'rgba(255, 195, 0, 0.8)',
      info: 'rgba(52, 152, 219, 0.8)'
    };

    ${analytics.hourlyDistribution.length > 0 ? `
    // Timeline Chart
    new Chart(document.getElementById('timelineChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(analytics.hourlyDistribution.map(h => {
          const date = new Date(h.hour);
          return date.toLocaleString('en-US', {
            timeZone: 'UTC',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          }) + ' UTC';
        }))},
        datasets: [{
          label: 'Events per Hour',
          data: ${JSON.stringify(analytics.hourlyDistribution.map(h => h.count))},
          borderColor: chartColors.primary,
          backgroundColor: 'rgba(42, 82, 152, 0.1)',
          tension: 0.4,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return value.toLocaleString();
              }
            }
          }
        }
      }
    });
    ` : ''}

    ${analytics.topAccounts.length > 0 ? `
    // Account Bar Chart
    new Chart(document.getElementById('accountChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(analytics.topAccounts.map(a => a.account))},
        datasets: [{
          label: 'Events',
          data: ${JSON.stringify(analytics.topAccounts.map(a => a.count))},
          backgroundColor: chartColors.primary
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return value.toLocaleString();
              }
            }
          }
        }
      }
    });

    // Account Pie Chart
    new Chart(document.getElementById('accountPieChart'), {
      type: 'doughnut',
      data: {
        labels: ${JSON.stringify(analytics.topAccounts.slice(0, 5).map(a => a.account))},
        datasets: [{
          data: ${JSON.stringify(analytics.topAccounts.slice(0, 5).map(a => a.count))},
          backgroundColor: [
            chartColors.primary,
            chartColors.secondary,
            chartColors.success,
            chartColors.warning,
            chartColors.info
          ]
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right'
          }
        }
      }
    });
    ` : ''}
    
    ${analytics.topHostnames.length > 0 ? `
    // Hostname Bar Chart
    new Chart(document.getElementById('hostnameChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(analytics.topHostnames.map(h => h.hostname))},
        datasets: [{
          label: 'Events',
          data: ${JSON.stringify(analytics.topHostnames.map(h => h.count))},
          backgroundColor: chartColors.info
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return value.toLocaleString();
              }
            }
          },
          x: {
            ticks: {
              maxRotation: 45,
              minRotation: 45
            }
          }
        }
      }
    });

    // Hostname Pie Chart  
    new Chart(document.getElementById('hostnamePieChart'), {
      type: 'doughnut',
      data: {
        labels: ${JSON.stringify(analytics.topHostnames.slice(0, 5).map(h => h.hostname))},
        datasets: [{
          data: ${JSON.stringify(analytics.topHostnames.slice(0, 5).map(h => h.count))},
          backgroundColor: [
            chartColors.info,
            chartColors.primary,
            chartColors.secondary,
            chartColors.success,
            chartColors.warning
          ]
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right'
          }
        }
      }
    });
    ` : ''}
    
    ${analytics.topInstances.length > 0 ? `
    // EC2 Instance Chart
    new Chart(document.getElementById('instanceChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(analytics.topInstances.map(i => i.instanceId))},
        datasets: [{
          label: 'Events',
          data: ${JSON.stringify(analytics.topInstances.map(i => i.count))},
          backgroundColor: 'rgba(255, 193, 7, 0.8)'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return value.toLocaleString();
              }
            }
          },
          x: {
            ticks: {
              maxRotation: 45,
              minRotation: 45,
              font: { size: 10 }
            }
          }
        }
      }
    });
    ` : ''}
    
    ${analytics.topEnis.length > 0 ? `
    // ENI Chart
    new Chart(document.getElementById('eniChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(analytics.topEnis.map(e => e.eniId))},
        datasets: [{
          label: 'Events',
          data: ${JSON.stringify(analytics.topEnis.map(e => e.count))},
          backgroundColor: 'rgba(46, 204, 113, 0.8)'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return value.toLocaleString();
              }
            }
          },
          x: {
            ticks: {
              maxRotation: 45,
              minRotation: 45,
              font: { size: 10 }
            }
          }
        }
      }
    });
    ` : ''}
    
    ${analytics.topVpcs.length > 0 ? `
    // VPC Chart
    new Chart(document.getElementById('vpcChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(analytics.topVpcs.map(v => v.vpcId))},
        datasets: [{
          label: 'Events',
          data: ${JSON.stringify(analytics.topVpcs.map(v => v.count))},
          backgroundColor: 'rgba(155, 89, 182, 0.8)'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return value.toLocaleString();
              }
            }
          },
          x: {
            ticks: {
              maxRotation: 45,
              minRotation: 45,
              font: { size: 10 }
            }
          }
        }
      }
    });
    ` : ''}

    ${analytics.correlationSizes.small > 0 || analytics.correlationSizes.medium > 0 || analytics.correlationSizes.large > 0 ? `
    // Correlation Size Chart
    new Chart(document.getElementById('correlationSizeChart'), {
      type: 'bar',
      data: {
        labels: ['Small (1-5 events)', 'Medium (6-20 events)', 'Large (20+ events)'],
        datasets: [{
          label: 'Number of Correlations',
          data: [${analytics.correlationSizes.small}, ${analytics.correlationSizes.medium}, ${analytics.correlationSizes.large}],
          backgroundColor: [chartColors.success, chartColors.warning, chartColors.secondary]
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true
          }
        }
      }
    });
    ` : ''}

    ${analytics.networkIssues.transmitFailures > 0 || analytics.networkIssues.dnsFailures > 0 ? `
    // Network Issues Chart
    new Chart(document.getElementById('networkChart'), {
      type: 'pie',
      data: {
        labels: ['Transmission Failures', 'DNS Issues', 'VPC Problems', 'Interface Errors'],
        datasets: [{
          data: [
            ${analytics.networkIssues.transmitFailures},
            ${analytics.networkIssues.dnsFailures},
            ${analytics.networkIssues.vpcIssues},
            ${analytics.networkIssues.interfaceErrors}
          ],
          backgroundColor: [
            chartColors.secondary,
            chartColors.warning,
            chartColors.primary,
            chartColors.info
          ]
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });
    ` : ''}

    ${analytics.timelineData.length > 0 ? `
    // Timeline visualization for correlations
    const timelineData = [];
    const colors = ['rgba(42, 82, 152, 0.8)', 'rgba(255, 107, 107, 0.8)', 'rgba(46, 204, 113, 0.8)', 'rgba(255, 195, 0, 0.8)', 'rgba(52, 152, 219, 0.8)'];
    
    // Sort by start time and group by overlapping times
    const sortedData = ${JSON.stringify(analytics.timelineData.slice(0, 50))}.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    
    // Create traces for each correlation
    sortedData.forEach((item, i) => {
      timelineData.push({
        x: [new Date(item.startTime), new Date(item.endTime)],
        y: [item.requestId.substring(0, 12), item.requestId.substring(0, 12)],
        name: item.requestId.substring(0, 8) + '...',
        text: 'Request: ' + item.requestId + '<br>Events: ' + item.eventCount + '<br>Account: ' + item.accountId + '<br>Host: ' + (item.hostname || 'unknown') + 
              '<br>Start: ' + new Date(item.startTime).toLocaleString('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'}) + ' UTC' +
              '<br>End: ' + new Date(item.endTime).toLocaleString('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'}) + ' UTC' +
              '<br>Duration: ' + ((new Date(item.endTime) - new Date(item.startTime)) / 1000).toFixed(1) + 's',
        type: 'scatter',
        mode: 'lines+markers',
        line: {width: 3, color: colors[i % colors.length]},
        marker: {size: 8, symbol: ['circle', 'diamond'][i % 2]},
        showlegend: false,
        hovertemplate: '%{text}<extra></extra>'
      });
    });
    
    Plotly.newPlot('ganttChart', timelineData, {
      xaxis: {
        title: 'Timeline (UTC)',
        type: 'date',
        tickformat: '%b %d, %H:%M',
        hoverformat: '%Y-%m-%d %H:%M:%S UTC',
        showgrid: true,
        gridcolor: 'rgba(200, 200, 200, 0.3)',
        nticks: 10
      },
      yaxis: {
        title: 'Request IDs',
        showticklabels: true,
        tickfont: {size: 10},
        automargin: true
      },
      height: 600,
      margin: {l: 120, r: 50, t: 50, b: 80},
      hovermode: 'closest',
      plot_bgcolor: 'rgba(245, 245, 245, 0.5)',
      paper_bgcolor: 'white'
    });
    ` : ''}
  </script>
</body>
</html>`;
  
  return html;
}

// Main execution
(async () => {
  const startTime = Date.now();
  
  try {
    console.log('\n📊 Analyzing database...');
    const analytics = await analyzeDatabase(dbPath);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
    
    console.log('\n✨ Analysis Complete:');
    console.log(`   ├─ Total Events: ${analytics.totalEvents.toLocaleString()}`);
    console.log(`   ├─ Correlations: ${analytics.totalCorrelations.toLocaleString()}`);
    console.log(`   ├─ Affected Accounts: ${analytics.accountIds.size.toLocaleString()}`);
    console.log(`   ├─ Active Hosts: ${analytics.hostnames.size.toLocaleString()}`);
    console.log(`   ├─ EC2 Instances: ${analytics.instanceIds.size.toLocaleString()}`);
    console.log(`   ├─ ENIs: ${analytics.eniIds.size.toLocaleString()}`);
    console.log(`   ├─ VPCs: ${analytics.vpcIds.size.toLocaleString()}`);
    console.log(`   └─ Error Patterns: ${analytics.errorPatterns.length}`);
    
    console.log('\n📝 Generating HTML dashboard...');
    const html = generateDashboard(analytics, { dbPath, elapsed });
    
    fs.writeFileSync(outputFile, html);
    console.log(`\n✅ Dashboard saved to: ${outputFile}`);
    
    // Try to open in browser
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').exec(`${opener} "${outputFile}"`, (error) => {
      if (!error) {
        console.log('🌐 Dashboard opened in browser');
      }
    });
  } catch (error) {
    console.error('\n❌ Error generating dashboard:', error.message);
    process.exit(1);
  }
})();