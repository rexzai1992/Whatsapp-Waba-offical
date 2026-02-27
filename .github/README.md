# WhatsApp Business API Workflow Engine

This project integrates with the official Meta WhatsApp Business Platform (Cloud API). It does not use Baileys or the WhatsApp Web API.

> [!CAUTION]
> Breaking change: if you were using the previous Baileys/WhatsApp Web flow, you must migrate to the official Cloud API setup.
> See `docs/waba.md` for configuration details.

## What it does
- Receives inbound WhatsApp messages via webhook (`/webhook`).
- Runs keyword-based workflows and conversational components.
- Sends outbound messages via the official Cloud API.
- Supports single-company (env) and multi-company (Supabase) configuration.

## Docs
- `docs/waba.md` - WhatsApp Business Cloud API setup
- `docs/workflows.md` - Workflow engine and action formats
- `docs/conversational-components.md` - Conversational components API
- `docs/schema.sql` - Full database schema

## Disclaimer
This project is not affiliated with Meta or WhatsApp. "WhatsApp" is a trademark of its respective owner.

## License
MIT. See `LICENSE`.
