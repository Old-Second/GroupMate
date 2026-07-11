import { AbstractTool } from './AbstractTool.js'
import { Config } from '../config.js'
import { clampNumber, fetchJsonWithTimeout, previewBody, truncateText } from './ToolUtils.js'

const SEARCH_TYPES = ['repositories', 'issues', 'users', 'code', 'custom']
const CUSTOM_PATH_ALLOWLIST = [
  /^\/repos\/[^/?#]+\/[^/?#]+(\/[A-Za-z0-9_./-]+)?(\?.*)?$/,
  /^\/users\/[^/?#]+(\/[A-Za-z0-9_./-]+)?(\?.*)?$/,
  /^\/orgs\/[^/?#]+(\/[A-Za-z0-9_./-]+)?(\?.*)?$/
]

export class GithubAPITool extends AbstractTool {
  name = 'github'

  parameters = {
    properties: {
      q: {
        type: 'string',
        description: 'search keyword. you should build it. If you want to find from specified repo, please must use repo:ORG/REPO as part of the keyword.'
      },
      type: {
        type: 'string',
        enum: SEARCH_TYPES,
        description: 'search type. If custom is chosen, you must provide a safe GitHub API relative path.'
      },
      num: {
        type: 'number',
        description: 'search results limit number, default is 5, max is 10'
      },
      fullUrl: {
        type: 'string',
        description: 'if type is custom, provide a relative GitHub API path, such as /repos/OWNER/REPO/issues?per_page=5'
      }
    },
    required: ['type']
  }

  func = async function (opts) {
    let { q = '', type, num = 5, fullUrl = '' } = opts
    if (!SEARCH_TYPES.includes(type)) {
      type = 'repositories'
    }
    const perPage = clampNumber(num, 1, 10, 5)
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'chatgpt-plugin'
    }
    if (Config.githubAPIKey) {
      headers.Authorization = `Bearer ${Config.githubAPIKey}`
    }

    let url
    if (type === 'custom') {
      if (!isSafeCustomPath(fullUrl)) {
        return 'github query failed: custom path is not allowed. Use a relative /repos, /users or /orgs GitHub API path.'
      }
      url = `${Config.githubAPI}${withPerPage(fullUrl, perPage)}`
    } else {
      if (!q) {
        return 'github query failed: missing search keyword'
      }
      url = `${Config.githubAPI}/search/${type}?q=${encodeURIComponent(q)}&per_page=${perPage}`
    }

    const result = await fetchJsonWithTimeout(url, { headers })
    if (result.error) {
      return `github query failed: ${result.error}`
    }
    const normalized = normalizeGithubResponse(result.json)
    return `the search results are here in json format:\n${JSON.stringify(normalized)} \n(Notice that these information are only available for you, the user cannot see them, you next answer should consider about the information)`
  }

  description = 'Useful when you want to search something from api.github.com. You can use preset search types or safe relative GitHub API paths. Automatically adjust the query and params if any error messages return.'
}

function isSafeCustomPath (fullUrl) {
  if (!fullUrl || typeof fullUrl !== 'string') {
    return false
  }
  if (!fullUrl.startsWith('/') || fullUrl.startsWith('//') || fullUrl.includes('://')) {
    return false
  }
  return CUSTOM_PATH_ALLOWLIST.some(pattern => pattern.test(fullUrl))
}

function withPerPage (fullUrl, perPage) {
  const [path, query = ''] = fullUrl.split('?')
  const params = new URLSearchParams(query)
  if (!params.has('per_page')) {
    params.set('per_page', String(perPage))
  }
  return `${path}?${params.toString()}`
}

function normalizeGithubResponse (data) {
  if (Array.isArray(data)) {
    return data.slice(0, 10).map(normalizeGithubItem)
  }
  if (Array.isArray(data?.items)) {
    return {
      total_count: data.total_count,
      incomplete_results: data.incomplete_results,
      items: data.items.slice(0, 10).map(normalizeGithubItem)
    }
  }
  if (data?.message) {
    return {
      message: data.message,
      documentation_url: data.documentation_url
    }
  }
  return normalizeGithubItem(data)
}

function normalizeGithubItem (item) {
  if (!item || typeof item !== 'object') {
    return item
  }
  return {
    name: item.full_name || item.name || item.login || item.title,
    html_url: item.html_url,
    api_url: item.url,
    state: item.state,
    description: truncateText(item.description || item.body || item.text_matches?.[0]?.fragment || '', 500),
    language: item.language,
    stars: item.stargazers_count,
    updated_at: item.updated_at,
    created_at: item.created_at,
    score: item.score,
    preview: previewBody(JSON.stringify(item), 800)
  }
}
