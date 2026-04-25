# OTLP ingest (CDX stats)

This document describes the OTLP HTTP ingest path exposed by `cdx-stats` and
how Codex OTEL events are bridged into the stats event model in standalone
`mcp-cdx`.

The OTLP endpoints are exposed by the stats server embedded in the app-server
orchestrator. Start it locally with `npm run start:cdx-appserver`, or install
the default `cdx` entry with `./install.sh install`.

## Endpoints

- `POST /v1/logs`
- `POST /v1/traces`
- `GET /api/otel/metrics`

The server accepts OTLP/HTTP JSON payloads. Protobuf OTLP
(`application/x-protobuf`) and OTLP/gRPC are not handled here.

## Configuration

- `CDX_STATS_OTLP_ENABLED=1` enables ingest (default when stats is enabled).
- `CDX_STATS_OTLP_MAX_BYTES` caps request bodies (default: `5000000`).
- `CDX_STATS_OTLP_LOG_BODY_LIMIT` caps log message length (default: `2000`).

## Run/agent/task identification

The bridge resolves run, agent, and task identifiers from the following
sources, in order:

1. Query params: `runId`, `agentId`, `taskId`.
2. Headers: `x-cdx-run-id`, `x-cdx-agent-id`, `x-cdx-task-id`.
3. OTLP attributes (record, then scope, then resource):
   - Run: `cdx.run_id`, `run.id`, `run_id`, `runId`, `conversation.id`,
     `conversation_id`, `conversationId`, `session.id`, `session_id`,
     `sessionId`, `traceId`.
   - Agent: `cdx.agent_id`, `agent.id`, `agent_id`, `agentId`,
     `conversation.id`, `conversation_id`, `conversationId`, `worker.id`,
     `worker_id`, `workerId`.
   - Task: `cdx.task_id`, `task.id`, `task_id`, `taskId`.
4. JSON body fields when the log record body is a JSON object.

If no run id is resolved but an agent id is present, the agent id is used as
the run id. Otherwise the log record is dropped.

## Mapping rules

The ingest layer maps selected Codex OTEL events into stats events:

- `codex.conversation_starts` to `run.started` plus `agent.started`
- `codex.user_prompt` to `appserver.notification` (`agentMessage`)
- `codex.sse_event` plus `event.kind=response.completed` to `turn.completed`
- `codex.tool_result` to `otel.tool_result`
- `codex.tool_decision` to `otel.tool_decision`
- `codex.api_request` to `otel.api_request`
- Other events to `otel.log`

Token usage is read from OTEL attributes:
`input_token_count`, `cached_token_count`, `output_token_count`.

## Example Codex OTEL config

Configure Codex to send OTLP/HTTP JSON logs to the stats server:

```toml
[otel]
exporter = { kind = "otlp_http", endpoint = "http://127.0.0.1:PORT/v1/logs", protocol = "json" }
trace_exporter = { kind = "otlp_http", endpoint = "http://127.0.0.1:PORT/v1/traces", protocol = "json" }
log_user_prompt = true
```

Replace `PORT` with the `cdx-stats` server port.

## Responses

- `POST /v1/logs` returns `accepted`, `rejected`, and `partialSuccess`, with
  `rejectedLogRecords` when any log records are dropped.
- `POST /v1/traces` returns `accepted`, `rejected`, and `partialSuccess`, with
  `rejectedSpans` when any spans are dropped.
- `GET /api/otel/metrics` returns OpenTelemetry-style metrics as JSON.

## Limitations

- OTLP protobuf and gRPC ingest are not implemented.
- Trace spans are aggregated as `otel.traces` events with a span count.
- Run completion is not inferred from OTEL data; runs remain `running` unless
  another system emits `run.completed`.
