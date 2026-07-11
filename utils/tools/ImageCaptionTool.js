import { AbstractTool } from './AbstractTool.js'
import fetch, { File, FormData } from 'node-fetch'
import { Config } from '../config.js'
import { fetchImageBuffer, previewBody } from './ToolUtils.js'
export class ImageCaptionTool extends AbstractTool {
  name = 'imageCaption'

  parameters = {
    properties: {
      imgUrl: {
        type: 'string',
        description: 'the url of the image.'
      },
      qq: {
        type: 'string',
        description: 'if the picture is avatar of a user, input his qq number'
      },
      question: {
        type: 'string',
        description: 'when you need an answer for a question based on an image, write your question in English here.'
      }
    },
    required: []
  }

  description = 'useful when you want to know what is inside a photo, such as user\'s avatar or other pictures'

  func = async function (opts, e) {
    let { imgUrl, qq, question } = opts
    if (isNaN(qq) || !qq) qq = e.sender.user_id
    if (!imgUrl && qq) {
      imgUrl = `https://q1.qlogo.cn/g?b=qq&s=160&nk=${qq}`
    }
    if (!imgUrl) {
      return 'you must give at least one parameter of imgUrl and qq'
    }
    let image
    try {
      image = await fetchImageBuffer(imgUrl)
    } catch (err) {
      return `image caption failed: ${err.message}`
    }
    // await fs.writeFileSync(`data/chatgpt/${crypto.randomUUID()}`, buffer)
    let formData = new FormData()
    formData.append('file', new File([image.buffer], 'file.png', { type: image.contentType || 'image/png' }))
    let endpoint = 'image-captioning'
    if (question) {
      endpoint = 'visual-qa?q=' + question
    }
    let captionRes = await fetch(`${Config.extraUrl}/${endpoint}`, {
      method: 'POST',
      body: formData
    })
    if (captionRes.status === 200) {
      let result = await captionRes.text()
      return `${result}`
    } else {
      const body = await captionRes.text()
      return `image caption failed: upstream returned ${captionRes.status} ${captionRes.statusText || ''}, body preview=${previewBody(body)}`
    }
  }
}
