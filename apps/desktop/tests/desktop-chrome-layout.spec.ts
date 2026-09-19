import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  desktopChromeBounds,
  desktopTitlebarDragStart,
  HARNESS_UPDATE_RADIUS,
  insetDesktopContentBounds,
} from '../src/desktop-chrome-layout.ts'
import { DESKTOP_TITLEBAR_HEIGHT } from '../src/shell-protocol.ts'

const content = { x: 0, y: 0, width: 1200, height: 800 }

describe('desktop mode chrome geometry', () => {
  it('keeps closed chrome inside the native title bar', () => {
    expect(desktopChromeBounds({
      platform: 'darwin',
      mode: 'harness',
      surface: 'closed',
      content,
    })).toEqual({ x: 88, y: 6, width: 164, height: 32 })
    expect(desktopChromeBounds({
      platform: 'darwin',
      mode: 'chat',
      surface: 'closed',
      content,
    })).toEqual({ x: 88, y: 6, width: 200, height: 32 })
    expect(desktopChromeBounds({
      platform: 'win32', mode: 'harness', surface: 'closed', content,
    })).toEqual({ x: 72, y: 6, width: 164, height: 32 })
  })

  it('keeps each closed control outside the title-bar drag region', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const chrome = desktopChromeBounds({
        platform,
        mode: 'chat',
        surface: 'closed',
        content,
      })
      expect(chrome.x + chrome.width).toBeLessThanOrEqual(desktopTitlebarDragStart(platform))
    }
  })

  it('expands only to the Chat menu and the full dialog', () => {
    expect(desktopChromeBounds({
      platform: 'darwin', mode: 'chat', surface: 'chat-menu', content,
    })).toEqual({ x: 88, y: 6, width: 200, height: 132 })
    expect(desktopChromeBounds({
      platform: 'darwin', mode: 'chat', surface: 'dialog', content,
    })).toEqual(content)
  })

  it('gives the Harness update card a card-sized rectangle in the upper third', () => {
    const card = desktopChromeBounds({
      platform: 'darwin', mode: 'harness', surface: 'harness-update', content,
    })

    expect(card).toEqual({ x: 450, y: 159, width: 300, height: 216 })
    // Horizontally centered on the content, but its center is one third of the
    // content height down, so it never lands on the geometric middle.
    expect(card.x + card.width / 2).toBe(content.width / 2)
    expect(card.y + card.height / 2).toBeLessThan(content.height / 2)
  })

  it('keeps the update card inside an offset content rectangle', () => {
    const offset = { x: 20, y: 30, width: 1200, height: 800 }
    const card = desktopChromeBounds({
      platform: 'win32', mode: 'chat', surface: 'harness-update', content: offset,
    })

    expect(card).toEqual({ x: 470, y: 189, width: 300, height: 216 })
    expect(card.x).toBeGreaterThanOrEqual(offset.x)
    expect(card.y).toBeGreaterThanOrEqual(offset.y + DESKTOP_TITLEBAR_HEIGHT)
    expect(card.x + card.width).toBeLessThanOrEqual(offset.x + offset.width)
    expect(card.y + card.height).toBeLessThanOrEqual(offset.y + offset.height)
  })

  it('keeps the update card clear of the title bar in a short window', () => {
    expect(desktopChromeBounds({
      platform: 'darwin', mode: 'harness', surface: 'harness-update', content: { x: 0, y: 0, width: 400, height: 200 },
    })).toEqual({ x: 50, y: 44, width: 300, height: 200 })
  })

  it('reserves only the native title bar for Chat without producing negative bounds', () => {
    expect(insetDesktopContentBounds(content, DESKTOP_TITLEBAR_HEIGHT)).toEqual({
      x: 0,
      y: 44,
      width: 1200,
      height: 756,
    })
    expect(insetDesktopContentBounds({ x: 2, y: 3, width: 100, height: 40 }, DESKTOP_TITLEBAR_HEIGHT)).toEqual({
      x: 2,
      y: 43,
      width: 100,
      height: 0,
    })
  })

  it('clips the update card view to the corner the card itself paints', () => {
    const css = readFileSync(new URL('../resources/mode-chrome.css', import.meta.url), 'utf8')
    const card = /#harness-update\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const radius = Number(/border-radius:\s*(\d+)px/.exec(card)?.[1])
    // A radius the card paints but the native view never clips to is the white
    // square a user sees, so the two values are one contract, not two choices.
    expect(radius).toBe(HARNESS_UPDATE_RADIUS)
  })
})
