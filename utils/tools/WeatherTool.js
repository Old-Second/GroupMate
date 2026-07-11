import { AbstractTool } from './AbstractTool.js'
import { Config } from '../config.js'
import { fetchJsonWithTimeout, previewBody } from './ToolUtils.js'

export class WeatherTool extends AbstractTool {
  name = 'weather'

  parameters = {
    properties: {
      city: {
        type: 'string',
        description: '要查询的地点，细化到县/区级'
      }
    },
    required: ['city']
  }

  func = async function (opts) {
    const { city } = opts
    if (!city) {
      return 'weather query failed: missing city'
    }

    const errors = []
    if (Config.amapKey) {
      const amap = await queryAmapWeather(city)
      if (amap.ok) {
        return `the weather information of area ${amap.cityName} in json format is:\n${JSON.stringify(amap.data)}`
      }
      errors.push(`amap: ${amap.error}`)
    } else {
      errors.push('amap: API key is not configured')
    }

    const openMeteo = await queryOpenMeteoWeather(city)
    if (openMeteo.ok) {
      return `the weather information of area ${openMeteo.cityName} from Open-Meteo in json format is:\n${JSON.stringify(openMeteo.data)}`
    }
    errors.push(`open-meteo: ${openMeteo.error}`)
    return `weather query failed: ${errors.join('; ')}`
  }

  description = 'Useful when you want to query weather '
}

async function queryAmapWeather (city) {
  const district = await fetchJsonWithTimeout(`https://restapi.amap.com/v3/config/district?keywords=${encodeURIComponent(city)}&subdistrict=1&key=${Config.amapKey}`)
  if (district.error) {
    return { ok: false, error: district.error }
  }
  const firstDistrict = district.json?.districts?.[0]
  const adcode = firstDistrict?.adcode
  if (!adcode) {
    return { ok: false, error: `area not found: ${city}, response=${previewBody(district.body, 500)}` }
  }

  const weather = await fetchJsonWithTimeout(`https://restapi.amap.com/v3/weather/weatherInfo?city=${adcode}&key=${Config.amapKey}`)
  if (weather.error) {
    return { ok: false, error: weather.error }
  }
  const result = weather.json?.lives?.[0]
  if (!result) {
    return { ok: false, error: `weather data not found: ${previewBody(weather.body, 500)}` }
  }
  return {
    ok: true,
    cityName: firstDistrict.name,
    data: result
  }
}

async function queryOpenMeteoWeather (city) {
  const geo = await fetchJsonWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`)
  if (geo.error) {
    return { ok: false, error: geo.error }
  }
  const location = geo.json?.results?.[0]
  if (!location) {
    return { ok: false, error: `area not found: ${city}, response=${previewBody(geo.body, 500)}` }
  }

  const forecastUrl = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${location.latitude}&longitude=${location.longitude}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m' +
    '&timezone=auto'
  const weather = await fetchJsonWithTimeout(forecastUrl)
  if (weather.error) {
    return { ok: false, error: weather.error }
  }
  if (!weather.json?.current) {
    return { ok: false, error: `weather data not found: ${previewBody(weather.body, 500)}` }
  }
  return {
    ok: true,
    cityName: [location.name, location.admin1, location.country].filter(Boolean).join(', '),
    data: {
      location,
      current: weather.json.current,
      current_units: weather.json.current_units
    }
  }
}
