# Authentication options for the HTTP API | Grafana documentation

_Source: https://grafana.com/docs/grafana/latest/developers/http_api/authentication/_

---

[Documentation](/docs/)![breadcrumb arrow](/static/assets/img/icons/grafana-icon-breadcrumb-arrow-gray.svg) [Grafana documentation](/docs/grafana/latest/)![breadcrumb arrow](/static/assets/img/icons/grafana-icon-breadcrumb-arrow-gray.svg) [Developers](/docs/grafana/latest/developers/)![breadcrumb arrow](/static/assets/img/icons/grafana-icon-breadcrumb-arrow-gray.svg) [HTTP API](/docs/grafana/latest/developers/http_api/)![breadcrumb arrow](/static/assets/img/icons/grafana-icon-breadcrumb-arrow-gray.svg) Authentication

Enterprise Open source

# Authentication options for the HTTP API[](#authentication-options-for-the-http-api)

You can authenticate HTTP API requests using basic authentication, a service account token, or a session cookie (acquired via regular login or OAuth).

### Basic auth[](#basic-auth)

If basic auth is enabled (it is enabled by default), then you can authenticate your HTTP request via standard basic auth. Basic auth will also authenticate LDAP users.

curl example:

bash  ![Copy code to clipboard](/media/images/icons/icon-copy-small-2.svg) Copy

```bash
curl http://admin:admin@localhost:3000/api/org
{"id":1,"name":"Main Org."}
```

### Service account token[](#service-account-token)

To create a service account token, click on **Administration** in the left-side menu, click **Users and access**, then **Service Accounts**. For more information on how to use service account tokens, refer to the [Service Accounts](/docs/grafana/latest/administration/service-accounts/) documentation.

You use the token in all requests in the `Authorization` header, like this:

**Example**:

http  ![Copy code to clipboard](/media/images/icons/icon-copy-small-2.svg) Copy

```http
GET http://your.grafana.com/api/dashboards/db/mydash HTTP/1.1
Accept: application/json
Authorization: Bearer eyJrIjoiT0tTcG1pUlY2RnVKZTFVaDFsNFZXdE9ZWmNrMkZYbk
```

The `Authorization` header value should be *`Bearer <YOUR_SERVICE_ACCOUNT_TOKEN>`*.

## Was this page helpful?

 ![👍](/media/images/svg/thumbs-up.svg) Yes ![👎](/media/images/svg/thumbs-up.svg) No

[

Suggest an edit in GitHub](https://github.com/grafana/grafana/edit/main/docs/sources/developers/http_api/authentication.md)[

Create a GitHub issue](https://github.com/grafana/grafana/issues/new?title=Documentation%20feedback:%20/docs/sources/developers/http_api/authentication.md)[

Email docs@grafana.com](mailto:docs@grafana.com)[

Help and support](/help/)[

Community](/community/)

## Related resources from Grafana Labs

Additional helpful documentation, links, and articles:

[

![webinar icon](/static/assets/img/icons/grafana-icon-card-webinar.svg)

17 Sep

Getting started with managing your metrics, logs, and traces using Grafana

In this webinar, we’ll demo how to get started using the LGTM Stack: Loki for logs, Grafana for visualization, Tempo for traces, and Mimir for metrics.

](https://grafana.com/go/webinar/getting-started-with-grafana-lgtm-stack/?pg=docs-grafana-latest-developers-http_api-authentication&plcmt=related)[

![video icon](/static/assets/img/icons/grafana-icon-card-video.svg)

60 min

Getting started with Grafana dashboard design

In this webinar, you'll learn how to design stylish and easily accessible Grafana dashboards that tell a story.

](https://grafana.com/go/webinar/getting-started-with-grafana-dashboard-design/?pg=docs-grafana-latest-developers-http_api-authentication&plcmt=related-2)[

![video icon](/static/assets/img/icons/grafana-icon-card-video.svg)

60 min

Building advanced Grafana dashboards

In this webinar, we’ll demo how to build and format Grafana dashboards.

](https://grafana.com/go/webinar/building-advanced-grafana-dashboards/?pg=docs-grafana-latest-developers-http_api-authentication&plcmt=related-3)