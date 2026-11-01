import type { Mood } from './bot-mood.mjs'

export type FigureMood = 'idle' | 'greet' | 'thinking' | 'working' | 'waiting' | 'done' | 'error' | 'resting'
export type FigureColors = { dark: boolean; light: string; deep: string; rod: string; screen: string; accent: string | null }
export function mix(hex: string, target: string, amount: number): string
export function luma(hex: string): number
export function figureColors(color: string): FigureColors
export function tintOf(color: string): string
export function figureMood(mood: Mood): FigureMood
export function sidebarFigure(mood: Mood): FigureMood | undefined
