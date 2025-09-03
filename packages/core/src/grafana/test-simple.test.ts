import { GrafanaDataSourceProxy } from "./grafana-datasource-proxy";
import fetch from "node-fetch";

jest.mock("node-fetch");

class TestProxy extends GrafanaDataSourceProxy {
  getDataSourceType(): string {
    return "test";
  }
  
  transformQuery() {
    return { queries: [], from: "", to: "" };
  }
  
  async *parseResponse(): AsyncIterable<any> {
    yield {};
  }
}

describe("Simple test", () => {
  let proxy: TestProxy;
  
  beforeEach(() => {
    proxy = new TestProxy({
      grafanaUrl: "http://test",
      authToken: "test",
      optimization: {
        connectionPool: false,
        queryBatching: false,
        caching: false,
        streamOptimization: false,
        compression: false,
      },
    });
  });
  
  afterEach(() => {
    if (proxy) {
      proxy.destroy();
    }
  });
  
  it("should pass", () => {
    expect(true).toBe(true);
  });
});