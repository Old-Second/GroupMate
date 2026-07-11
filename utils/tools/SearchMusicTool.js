import fetch from 'node-fetch'
import { AbstractTool } from './AbstractTool.js'
import { previewBody } from './ToolUtils.js'

export class SearchMusicTool extends AbstractTool {
  name = 'searchMusic'

  parameters = {
    properties: {
      keyword: {
        type: 'string',
        description: '音乐的标题或关键词, 可以是歌曲名或歌曲名+歌手名的组合'
      }
    },
    required: ['keyword']
  }

  func = async function (opts) {
    let { keyword } = opts
    try {
      let result = await searchMusic163(keyword)
      return `search result: ${result}`
    } catch (e) {
      return `music search failed: ${e}`
    }
  }

  description = 'Useful when you want to search music by keyword.'
}

export async function searchMusic163 (name) {
  let response = await fetch(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(name)}&type=1&offset=0&total=true&limit=6`, {
    headers: {
      Referer: 'https://music.163.com',
      'User-Agent': 'Mozilla/5.0'
    }
  })
  const contentType = response.headers.get('content-type') || ''
  const body = await response.text()
  if (!response.ok) {
    return `music search failed: upstream returned ${response.status} ${response.statusText || ''}, content-type=${contentType || 'unknown'}, body preview=${previewBody(body)}`
  }
  let json
  try {
    json = JSON.parse(body)
  } catch (err) {
    return `music search failed: upstream returned invalid JSON: ${err.message}`
  }
  if (json.result?.songCount > 0) {
    return json.result.songs.map(song => {
      return `id: ${song.id}, name: ${song.name}, artists: ${song.artists.map(a => a.name).join('&')}, alias: ${song.alias || 'none'}`
    }).join('\n')
  }
  return null
}
