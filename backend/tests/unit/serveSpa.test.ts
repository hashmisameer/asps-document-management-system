import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isSpaRequest, mountSpa } from '../../src/middleware/serveSpa.js'

/**
 * Serving the built frontend from the API.
 *
 * The two things that go wrong when an SPA is put behind an API are both here:
 * the API starts answering with HTML, or a page refresh answers with a 404.
 *
 * Mounted onto a bare Express app with a temporary dist folder rather than
 * through createApp(), because NODE_ENV is 'test' in here and production is
 * where this is switched on. What is under test is the middleware itself.
 */

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'asps-spa-'))

beforeAll(() => {
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ASPS</title>')
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>')
})

afterAll(() => {
  fs.rmSync(dist, { recursive: true, force: true })
})

/** An app shaped like the real one: the API first, then the SPA, then a 404. */
function appWithSpa(spaDir = dist) {
  const app = express()

  app.get('/api/employees', (_req, res) => {
    res.json({ items: [] })
  })
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND' } })
  })

  const mounted = mountSpa(app, spaDir)

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND' } })
  })

  return { app, mounted }
}

describe('isSpaRequest', () => {
  it('sends a page route to the SPA', () => {
    expect(isSpaRequest('GET', '/')).toBe(true)
    expect(isSpaRequest('GET', '/employees/42')).toBe(true)
    expect(isSpaRequest('HEAD', '/reports')).toBe(true)
  })

  it('leaves everything under /api to the API', () => {
    // A client waiting for JSON that receives HTML reports 'unexpected token
    // <', which says nothing at all about the URL being wrong.
    expect(isSpaRequest('GET', '/api')).toBe(false)
    expect(isSpaRequest('GET', '/api/employees')).toBe(false)
    expect(isSpaRequest('GET', '/api/nothing-here')).toBe(false)
  })

  it('does not answer a write with a page', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(isSpaRequest(method, '/employees'), method).toBe(false)
    }
  })

  it('is not fooled by a path that merely starts with the letters', () => {
    expect(isSpaRequest('GET', '/apiary')).toBe(true)
  })
})

describe('serving the SPA', () => {
  it('serves the page at the root', async () => {
    const { app } = appWithSpa()
    const response = await request(app).get('/')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.text).toContain('ASPS')
  })

  it('serves a page route the server has never heard of', async () => {
    // /employees/42 is a route React Router draws. Without this, refreshing
    // that page - or opening a link to it - is a 404.
    const { app } = appWithSpa()
    const response = await request(app).get('/employees/42')

    expect(response.status).toBe(200)
    expect(response.text).toContain('ASPS')
  })

  it('serves the built assets', async () => {
    const { app } = appWithSpa()
    const response = await request(app).get('/assets/index-abc123.js')

    expect(response.status).toBe(200)
    expect(response.text).toContain('console.log')
  })

  it('leaves the API answering JSON', async () => {
    const { app } = appWithSpa()

    const found = await request(app).get('/api/employees')
    expect(found.status).toBe(200)
    expect(found.body).toEqual({ items: [] })

    // Including a path the API does not recognise: an unknown endpoint is a
    // JSON 404, not a page.
    const missing = await request(app).get('/api/nothing-here')
    expect(missing.status).toBe(404)
    expect(missing.headers['content-type']).toContain('application/json')
  })

  it('does not answer a POST to an unknown path with a page', async () => {
    const { app } = appWithSpa()
    const response = await request(app).post('/employees')

    expect(response.status).toBe(404)
  })

  it('caches the hashed assets hard and the page not at all', async () => {
    const { app } = appWithSpa()

    // Vite writes a content hash into the name, so the file can never change
    // under a name a browser already has.
    const asset = await request(app).get('/assets/index-abc123.js')
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')

    // index.html names those files, so a stale copy points a browser at the
    // previous deployment's JavaScript.
    const page = await request(app).get('/')
    expect(page.headers['cache-control']).toBe('no-cache')

    // Anything else is revalidated rather than assumed immutable.
    const favicon = await request(app).get('/favicon.svg')
    expect(favicon.headers['cache-control']).toBe('public, max-age=0, must-revalidate')
  })

  it('mounts nothing when the frontend was never copied across', async () => {
    // A deployment that forgot frontend/dist behaves as it did before - a JSON
    // 404 - rather than throwing on the first request for a page.
    const { app, mounted } = appWithSpa(path.join(dist, 'not-built'))

    expect(mounted).toBe(false)

    const response = await request(app).get('/employees/42')
    expect(response.status).toBe(404)
    expect(response.headers['content-type']).toContain('application/json')
  })
})
