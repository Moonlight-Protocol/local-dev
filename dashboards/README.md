# Grafana dashboards (source of truth)

JSON definitions for the Moonlight Grafana dashboards on
[aha.grafana.net](https://aha.grafana.net). The Grafana instance is editable via
the UI, but this directory is the source of truth — direct UI edits will be
reverted by the next sync from here.

## Dashboards

- `provider-dashboard.json` — uid `provider-dashboard`. Tracks
  `provider-platform` traces with a `network` template variable
  (`local | testnet | mainnet`) that selects the service-name suffix.

## Sync

There is no automated sync today. To apply local changes to the Grafana
instance:

```bash
TOKEN="$GRAFANA_SA_TOKEN"  # see ../testnet/README.md / pm-theahaco/integrations/grafana.md

# Push provider-dashboard.json
jq '{dashboard: ., overwrite: true, message: "sync from dashboards/"}' \
    dashboards/provider-dashboard.json |
  curl -s -X POST "https://aha.grafana.net/api/dashboards/db" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d @-
```

## Pull current state from Grafana

```bash
curl -s "https://aha.grafana.net/api/dashboards/uid/provider-dashboard" \
  -H "Authorization: Bearer $TOKEN" |
  jq '.dashboard | del(.id, .version)' \
  > dashboards/provider-dashboard.json
```

`id` and `version` are instance-owned and stripped from the source-of-truth
file; `uid` is the cross-instance identity and kept.
