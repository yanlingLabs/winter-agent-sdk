// HTML -> MARKDOWN for `WebFetch` -- the conversion lives in `@yanlinglabs/winter-web` (one copy, shared
// with every other host of that package). A module that REGISTERS NOTHING (see `_domains.ts`).
export { convertFetchedHtml, decodeHtmlEntities, htmlToMarkdown, HtmlBudgetExceededError, WEB_FETCH_HTML_TRUNCATION_NOTICE } from "@yanlinglabs/winter-web";
