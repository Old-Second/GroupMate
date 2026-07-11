import { AbstractTool } from './AbstractTool.js'
import { Config } from '../config.js'

const SEARCH_DEPTHS = ['basic', 'advanced', 'fast', 'ultra-fast']
const TOPICS = ['general', 'news', 'finance']
const TIME_RANGES = ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y']

function clampMaxResults (num) {
  const parsed = Number(num)
  if (!Number.isFinite(parsed)) {
    return 5
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), 8)
}

function previewBody (body) {
  return body.replace(/\s+/g, ' ').slice(0, 300)
}

function truncateText (text, maxLength) {
  if (typeof text !== 'string') {
    return text
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

export class TavilySearchTool extends AbstractTool {
  name = 'search'

  parameters = {
    properties: {
      q: {
        type: 'string',
        description: 'search keyword'
      },
      num: {
        type: 'number',
        description: 'search results limit number, default is 5, max is 8'
      },
      searchDepth: {
        type: 'string',
        enum: SEARCH_DEPTHS,
        description: 'Tavily search depth, default is basic'
      },
      topic: {
        type: 'string',
        enum: TOPICS,
        description: 'Tavily search topic, default is general'
      },
      timeRange: {
        type: 'string',
        enum: TIME_RANGES,
        description: 'filter results by publish or update time, such as day, week, month or year'
      }
    },
    required: ['q']
  }

  func = async function (opts) {
    const { q, num = 5 } = opts
    if (!q) {
      return 'search failed: missing search keyword'
    }

    const key = Config.tavilyApiKey || process.env.TAVILY_API_KEY
    if (!key) {
      return 'search failed: Tavily API key is not configured. Please set tavilyApiKey or TAVILY_API_KEY.'
    }

    const searchDepth = SEARCH_DEPTHS.includes(opts.searchDepth) ? opts.searchDepth : 'basic'
    const topic = TOPICS.includes(opts.topic) ? opts.topic : 'general'
    const body = {
      query: q,
      max_results: clampMaxResults(num),
      search_depth: searchDepth,
      topic,
      include_answer: 'basic',
      include_raw_content: false,
      include_favicon: true
    }
    if (TIME_RANGES.includes(opts.timeRange)) {
      body.time_range = opts.timeRange
    }

    let tavilyResp
    try {
      tavilyResp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })
    } catch (err) {
      return `search failed: Tavily request failed: ${err.message}`
    }

    const contentType = tavilyResp.headers.get('content-type') || ''
    const respBody = await tavilyResp.text()
    if (!tavilyResp.ok || !contentType.includes('application/json')) {
      return `search failed: Tavily returned ${tavilyResp.status} ${tavilyResp.statusText || ''}, content-type=${contentType || 'unknown'}, body preview=${previewBody(respBody)}`
    }

    let tavilyRes
    try {
      tavilyRes = JSON.parse(respBody)
    } catch (err) {
      return `search failed: Tavily returned invalid JSON: ${err.message}`
    }

    if (!Array.isArray(tavilyRes.results)) {
      return `search failed: Tavily JSON has no results array: ${JSON.stringify(tavilyRes).slice(0, 500)}`
    }

    const res = tavilyRes.results.map(item => ({
      title: item.title,
      url: item.url,
      content: truncateText(item.content, 700),
      score: item.score,
      publishedDate: item.published_date,
      favicon: item.favicon
    }))
    return `the search results are here in json format:\n${JSON.stringify({
      answer: truncateText(tavilyRes.answer, 1000),
      results: res
    })} \n(Notice that these information are only available for you, the user cannot see them, you next answer should consider about the information)`
  }

  description = 'Useful when you want to search something from the Internet with Tavily. If you don\'t know much about the user\'s question, prefer to search about it! If you want to know further details of a result, you can use website tool'
}
