'use strict';

/**
 * Shared static contracts for the analysis pipeline and browser API boundary.
 * This module intentionally exports no runtime values; consumers reference its types through JSDoc.
 *
 * @typedef {'pass'|'warn'|'fail'} AnalysisStatus
 * @typedef {'A'|'B'|'C'|'D'|'F'} AnalysisGrade
 *
 * @typedef {object} RuleEvaluation
 * @property {string} id
 * @property {string} label
 * @property {number} maxPoints
 * @property {number} points
 * @property {AnalysisStatus} status
 * @property {string} detail
 * @property {string} [recommendation]
 *
 * @typedef {Omit<RuleEvaluation, 'recommendation'>} AnalysisCheck
 *
 * @typedef {object} OpenGraphMetadata
 * @property {string} title
 * @property {string} description
 * @property {string} image
 *
 * @typedef {object} AnalysisMetadata
 * @property {string} title
 * @property {number} titleLength
 * @property {string} description
 * @property {number} descriptionLength
 * @property {string} canonical
 * @property {string} canonicalRaw
 * @property {boolean} canonicalValid
 * @property {string} robots
 * @property {string} googlebot
 * @property {string} xRobotsTag
 * @property {string[]} xRobotsTags
 * @property {string} viewport
 * @property {string} lang
 * @property {OpenGraphMetadata} og
 *
 * @typedef {object} HeadingCounts
 * @property {number} h1
 * @property {number} h2
 * @property {number} h3
 * @property {number} h4
 * @property {number} h5
 * @property {number} h6
 *
 * @typedef {object} StructuredDataEvidence
 * @property {number} total
 * @property {number} parseable
 * @property {number} typed
 * @property {number} untyped
 * @property {number} invalid
 * @property {string[]} types
 *
 * @typedef {object} AnalysisContent
 * @property {{count: number, topKeywords: Array<{term: string, count: number}>}} words
 * @property {{counts: HeadingCounts, h1Texts: string[], skipsHeadingLevel: boolean}} headings
 * @property {{total: number, withAlt: number, emptyAlt: number, missingAlt: number}} images
 * @property {{total: number, internal: number, external: number}} links
 * @property {StructuredDataEvidence} structuredData
 * @property {number} structuredDataCount
 *
 * @typedef {object} PageSnapshotEvidence
 * @property {string} pageUrl
 * @property {AnalysisMetadata} metadata
 * @property {AnalysisContent} content
 *
 * @typedef {object} AnalysisRuleContract
 * @property {string} id
 * @property {string} label
 * @property {number} maxPoints
 * @property {(snapshot: PageSnapshotEvidence) => RuleEvaluation} evaluate
 *
 * @typedef {object} AnalysisReport
 * @property {number} score
 * @property {number} maxScore
 * @property {AnalysisGrade} grade
 * @property {string} methodologyVersion
 * @property {AnalysisMetadata} metadata
 * @property {AnalysisContent} content
 * @property {AnalysisCheck[]} checks
 * @property {string[]} recommendations
 *
 * @typedef {object} AnalyzeSuccessResponse
 * @property {true} ok
 * @property {string} url
 * @property {string} fetchedAt
 * @property {{redirectCount: number}} network
 * @property {AnalysisReport} report
 *
 * @typedef {object} ApiError
 * @property {string} code
 * @property {string} message
 *
 * @typedef {object} ApiErrorResponse
 * @property {false} ok
 * @property {ApiError} error
 *
 * @typedef {AnalyzeSuccessResponse|ApiErrorResponse} AnalyzeResponse
 *
 * @typedef {object} PageFetchResult
 * @property {Buffer} html
 * @property {string} finalUrl
 * @property {Record<string, string|string[]>} responseHeaders
 * @property {number} redirectCount
 *
 * @typedef {object} UrlSafetyPolicyContract
 * @property {(input: string|URL) => URL} normalize
 * @property {(input: string|URL, options?: {signal?: AbortSignal}) => Promise<{url: URL, addresses: Array<{address: string, family: 4|6, range: string}>, selectedAddress: {address: string, family: 4|6, range: string}}>} authorize
 * @property {(selectedAddress: {address: string, family: 4|6}) => import('node:net').LookupFunction} createPinnedLookup
 *
 * @typedef {object} RuntimeConfig
 * @property {string} host
 * @property {number} port
 * @property {number} fetchTimeoutMs
 * @property {number} dnsTimeoutMs
 * @property {number} maxResponseBytes
 * @property {number} maxRedirects
 * @property {number} maxUrlLength
 * @property {number[]} allowedTargetPorts
 * @property {number} rateLimitMax
 * @property {number} rateLimitWindowMs
 * @property {number} maxConcurrentAnalyses
 * @property {number} analysisTimeoutMs
 * @property {number} analysisMaxOldSpaceMb
 * @property {number} analysisMaxYoungSpaceMb
 * @property {number} analysisStackSizeMb
 * @property {boolean} trustProxy
 * @property {string} userAgent
 * @property {number} requestTimeoutMs
 */

module.exports = {};
