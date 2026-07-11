import { AbstractTool } from './AbstractTool.js'
import { Config } from '../config.js'
import { clampNumber, fetchJsonWithTimeout, previewBody, truncateText } from './ToolUtils.js'

const IMAGE_SOURCES = ['auto', 'tavily', 'brave', 'ikechan8370']

function normalizeTavilyImages (data, limit) {
  const images = []
  const pushImage = (img, context = {}) => {
    if (!img) return
    const url = typeof img === 'string' ? img : img.url || img.image_url || img.src
    if (!url) return
    images.push({
      title: truncateText((typeof img === 'object' && (img.title || img.description)) || context.title || '', 120),
      url,
      thumbnail: typeof img === 'object' ? (img.thumbnail_url || img.thumbnail || img.url) : url,
      source: context.url || '',
      description: truncateText(context.content || '', 300)
    })
  }
  data.images?.forEach(img => pushImage(img))
  data.results?.forEach(result => {
    result.images?.forEach(img => pushImage(img, result))
  })
  return images.slice(0, limit)
}

function normalizeBraveImages (data, limit) {
  return (data.results || []).map(item => ({
    title: truncateText(item.title || '', 120),
    url: item.properties?.url || item.url || item.thumbnail?.src,
    thumbnail: item.thumbnail?.src || item.properties?.url || item.url,
    source: item.url || '',
    description: truncateText(item.description || '', 300)
  })).filter(item => item.url).slice(0, limit)
}

function normalizeIkechanImages (data, limit) {
  return (data.data || data.results || []).map(item => ({
    title: truncateText(item.title || item.desc || '', 120),
    url: item.murl || item.url || item.img || item.image,
    thumbnail: item.turl || item.thumbnail || item.murl || item.url,
    source: item.purl || item.hostPageUrl || '',
    description: truncateText(item.desc || item.snippet || '', 300)
  })).filter(item => item.url).slice(0, limit)
}

export class SerpImageTool extends AbstractTool {
  name = 'searchImage'

  parameters = {
    properties: {
      q: {
        type: 'string',
        description: 'search keyword'
      },
      limit: {
        type: 'number',
        description: 'image number, default is 2, max is 6'
      },
      source: {
        type: 'string',
        enum: IMAGE_SOURCES,
        description: 'image search source, default follows imageSearchSource config'
      }
    },
    required: ['q']
  }

  func = async function (opts) {
    const q = opts.q
    if (!q) {
      return 'image search failed: missing search keyword'
    }
    const limit = clampNumber(opts.limit, 1, 6, 2)
    const configuredSource = IMAGE_SOURCES.includes(Config.imageSearchSource) ? Config.imageSearchSource : 'auto'
    const source = IMAGE_SOURCES.includes(opts.source) ? opts.source : configuredSource
    const sources = source === 'auto' ? ['tavily', 'brave'] : [source]
    const errors = []
    for (const currentSource of sources) {
      let result
      if (currentSource === 'tavily') {
        result = await searchTavilyImages(q, limit)
      } else if (currentSource === 'brave') {
        result = await searchBraveImages(q, limit)
      } else {
        result = await searchIkechanImages(q, limit)
      }
      if (result.ok) {
        return `images search results in json format:\n${JSON.stringify(result.images)}. the url field is actual picture url. You should use sendPicture to send them`
      }
      errors.push(`${currentSource}: ${result.error}`)
    }
    return `image search failed: ${errors.join('; ')}`
  }

  description = 'Useful when you want to search images from the Internet.'
}

async function searchTavilyImages (q, limit) {
  const key = Config.tavilyApiKey || process.env.TAVILY_API_KEY
  if (!key) {
    return { ok: false, error: 'Tavily API key is not configured' }
  }
  const result = await fetchJsonWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: q,
      max_results: limit,
      search_depth: 'basic',
      include_answer: false,
      include_images: true,
      include_image_descriptions: true,
      include_raw_content: false
    })
  })
  if (result.error) {
    return { ok: false, error: `Tavily ${result.error}` }
  }
  const images = normalizeTavilyImages(result.json, limit)
  if (!images.length) {
    return { ok: false, error: `Tavily returned no images: ${previewBody(result.body, 500)}` }
  }
  return { ok: true, images }
}

async function searchBraveImages (q, limit) {
  const key = Config.braveSearchApiKey || process.env.BRAVE_SEARCH_API_KEY
  if (!key) {
    return { ok: false, error: 'Brave Search API key is not configured' }
  }
  const url = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(q)}&count=${limit}&safesearch=moderate`
  const result = await fetchJsonWithTimeout(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': key
    }
  })
  if (result.error) {
    return { ok: false, error: `Brave ${result.error}` }
  }
  const images = normalizeBraveImages(result.json, limit)
  if (!images.length) {
    return { ok: false, error: `Brave returned no images: ${previewBody(result.body, 500)}` }
  }
  return { ok: true, images }
}

async function searchIkechanImages (q, limit) {
  const result = await fetchJsonWithTimeout(`https://serp.ikechan8370.com/image/bing?q=${encodeURIComponent(q)}&limit=${limit}`, {
    headers: {
      'X-From-Library': 'ikechan8370'
    }
  })
  if (result.error) {
    return { ok: false, error: `ikechan8370 ${result.error}` }
  }
  const images = normalizeIkechanImages(result.json, limit)
  if (!images.length) {
    return { ok: false, error: `ikechan8370 returned no images: ${previewBody(result.body, 500)}` }
  }
  return { ok: true, images }
}
