# Schema Generator (Protocol-Agnostic)

Generate a canonical `schema.json` for your connector builder from *any* target
system: REST/OpenAPI, SOAP/WSDL, GraphQL, gRPC/Protobuf, Databases, or plain
sample payloads.

## Output Format

```json
{
  "name": "HR Connector",
  "version": "1.0.0",
  "entities": [
    { "name": "User", "attributes": [ { "name": "UserID", "type": "String" } ] }
  ]
}