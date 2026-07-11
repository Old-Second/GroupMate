import { AbstractTool } from './AbstractTool.js'

export class SerpIkechan8370Tool extends AbstractTool {
  name = 'search'

  parameters = {
    properties: {
      q: {
        type: 'string',
        description: 'search keyword'
      },
      source: {
        type: 'string',
        enum: ['bing', 'google', 'baidu', 'duckduckgo'],
        description: 'search source, default value is bing'
      },
      num: {
        type: 'number',
        description: 'search results limit number, default is 5'
      }
    },
    required: ['q', 'source']
  }

  func = async function (opts) {
    let { q, source, num = 5 } = opts
    if (!source || !['google', 'bing', 'baidu', 'duckduckgo'].includes(source)) {
      source = 'bing'
    }
    const serpResp = await fetch(`https://serp.ikechan8370.com/${source}?q=${encodeURIComponent(q)}&lang=zh-CN&limit=${num}`, {
      headers: {
        'X-From-Library': 'ikechan8370'
      }
    })
    const contentType = serpResp.headers.get('content-type') || ''
    const body = await serpResp.text()
    if (!serpResp.ok || !contentType.includes('application/json')) {
      const preview = body.replace(/\s+/g, ' ').slice(0, 300)
      return `search failed: upstream returned ${serpResp.status} ${serpResp.statusText || ''}, content-type=${contentType || 'unknown'}, body preview=${preview}`
    }

    let serpRes
    try {
      serpRes = JSON.parse(body)
    } catch (err) {
      return `search failed: upstream returned invalid JSON: ${err.message}`
    }

    let res = serpRes.data || serpRes.results
    if (!Array.isArray(res)) {
      return `search failed: upstream JSON has no results array: ${JSON.stringify(serpRes).slice(0, 500)}`
    }
    res?.forEach(r => {
      delete r?.rank
    })
    return `the search results are here in json format:\n${JSON.stringify(res)} \n(Notice that these information are only available for you, the user cannot see them, you next answer should consider about the information)`
  }

  description = 'Useful when you want to search something from the Internet. If you don\'t know much about the user\'s question, prefer to search about it! If you want to know further details of a result, you can use website tool'
}
