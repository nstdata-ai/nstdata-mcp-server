# Nstdata Crawl for Cursor

Use Cursor Agent to read a web page as Markdown, start a site crawl, or retrieve results from an existing job. The plugin connects to the hosted Crawl MCP server over HTTPS. Setup requires a Nstdata account with Crawl access. Usage is billed to your Nstdata account.

## Connect in Cursor

1. In Cursor's plugin settings, choose **Add Marketplace → Import from GitHub** and enter `https://github.com/nstdata-ai/nstdata-mcp-server.git`. If you imported this repository previously, refresh the marketplace.
2. Select **nstdata-crawl** and choose **Add for Myself**. The other entry, **nstdata**, runs the local server and also supports Proxy tools.
3. In Cursor's MCP settings, connect the plugin's **crawl** server. Sign in to Nstdata if prompted, confirm the billing workspace, and select **Authorize and return**. To authorize with a key instead, select **Use an existing API Key**, enter your Crawl API key on the Nstdata authorization page, and select **Authorize**.
4. Return to Cursor and open an Agent chat. If you already configured Nstdata Crawl manually, disable that duplicate connection before trying the plugin.

> Use Nstdata Crawl to read https://example.com/ as Markdown and tell me the page title. Submit once. If the result contains a Markdown reference, read it.

A successful run returns the title **Example Domain** and its page text. If authorization expires, reconnect the server in Cursor. For a completed job, continue reading its existing result.

[MIT license](LICENSE)
