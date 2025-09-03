// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PeggyQueryParser } = require("./dist/index.js");

const parser = new PeggyQueryParser();

const queries = [
  "graylog(test)[5m]",
  "graylog-prod(test)[5m]",
  "graylog-prod(test)[5m] and on(id) graylog-staging(test)[5m]",
];

for (const query of queries) {
  console.log(`Testing: ${query}`);
  try {
    const result = parser.parse(query);
    console.log("  ✅ Parsed successfully");
    console.log(
      "  Sources:",
      result.leftStream.source,
      result.rightStream?.source || ""
    );
  } catch (error) {
    console.log("  ❌ Parse error:", error.message);
  }
  console.log("");
}
