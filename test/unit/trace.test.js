/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const tap = require('tap')
// TODO: convert to normal tap style.
// Below allows use of mocha DSL with tap runner.
tap.mochaGlobals()

const util = require('util')
const sinon = require('sinon')
const chai = require('chai')
const DESTINATIONS = require('../../lib/config/attribute-filter').DESTINATIONS
const expect = chai.expect
const helper = require('../lib/agent_helper')
const codec = require('../../lib/util/codec')
const codecEncodeAsync = util.promisify(codec.encode)
const codecDecodeAsync = util.promisify(codec.decode)
const Segment = require('../../lib/transaction/trace/segment')
const DTPayload = require('../../lib/transaction/dt-payload')
const Trace = require('../../lib/transaction/trace')
const Transaction = require('../../lib/transaction')

const NEWRELIC_TRACE_HEADER = 'newrelic'

describe('Trace', function () {
  let agent = null

  beforeEach(function () {
    agent = helper.loadMockedAgent()
  })

  afterEach(function () {
    helper.unloadAgent(agent)
  })

  it('should always be bound to a transaction', function () {
    // fail
    expect(function () {
      return new Trace()
    }).throws(/must be associated with a transaction/)

    // succeed
    const transaction = new Transaction(agent)
    const tt = new Trace(transaction)
    expect(tt.transaction).to.be.an.instanceof(Transaction)
  })

  it('should have the root of a Segment tree', function () {
    const tt = new Trace(new Transaction(agent))
    expect(tt.root).to.be.an.instanceof(Segment)
  })

  it('should be the primary interface for adding segments to a trace', function () {
    const transaction = new Transaction(agent)
    const trace = transaction.trace

    expect(function () {
      trace.add('Custom/Test17/Child1')
    }).to.not.throw()
  })

  describe('when serializing synchronously', () => {
    let details

    beforeEach(async () => {
      details = await makeTrace(agent)
    })

    it('should produce a transaction trace in the expected format', async function () {
      const traceJSON = details.trace.generateJSONSync()
      const reconstituted = await codecDecodeAsync(traceJSON[4])
      expect(traceJSON, 'full trace JSON').to.deep.equal(details.expectedEncoding)

      expect(reconstituted, 'reconstituted trace segments').to.deep.equal(details.rootNode)
    })

    it('should send response time', function () {
      details.transaction.getResponseTimeInMillis = function () {
        return 1234
      }

      const json = details.trace.generateJSONSync()
      expect(json[1]).to.equal(1234)
    })

    describe('when `simple_compression` is `false`', function () {
      it('should compress the segment arrays', async function () {
        const json = details.trace.generateJSONSync()

        expect(json[4]).to.match(/^[a-zA-Z0-9\+\/]+={0,2}$/, 'should be base64 encoded')

        const data = await codecDecodeAsync(json[4])
        expect(data).to.deep.equal(details.rootNode)
      })
    })

    describe('when `simple_compression` is `true`', function () {
      beforeEach(function () {
        agent.config.simple_compression = true
      })

      it('should not compress the segment arrays', function () {
        const json = details.trace.generateJSONSync()
        expect(json[4]).to.deep.equal(details.rootNode)
      })
    })
  })

  describe('when serializing asynchronously', () => {
    let details

    beforeEach(async () => {
      details = await makeTrace(agent)
    })

    it('should produce a transaction trace in the expected format', async function () {
      const traceJSON = await details.trace.generateJSONAsync()
      const reconstituted = await codecDecodeAsync(traceJSON[4])

      expect(traceJSON, 'full trace JSON').to.deep.equal(details.expectedEncoding)

      expect(reconstituted, 'reconstituted trace segments').to.deep.equal(details.rootNode)
    })

    it('should send response time', function () {
      details.transaction.getResponseTimeInMillis = function () {
        return 1234
      }

      // not using `trace.generateJSONAsync` because
      // util.promisify only returns 1st arg in callback
      // see: https://github.com/nodejs/node/blob/master/lib/internal/util.js#L332
      return new Promise((resolve, reject) => {
        details.trace.generateJSON((err, json, trace) => {
          if (err) {
            reject(err)
          }

          expect(json[1]).to.equal(1234)
          expect(trace).to.equal(details.trace)
          resolve()
        })
      })
    })

    describe('when `simple_compression` is `false`', function () {
      it('should compress the segment arrays', async function () {
        const json = await details.trace.generateJSONAsync()
        expect(json[4]).to.match(/^[a-zA-Z0-9\+\/]+={0,2}$/, 'should be base64 encoded')

        const data = await codecDecodeAsync(json[4])
        expect(data).to.deep.equal(details.rootNode)
      })
    })

    describe('when `simple_compression` is `true`', function () {
      beforeEach(function () {
        agent.config.simple_compression = true
      })

      it('should not compress the segment arrays', async function () {
        const json = await details.trace.generateJSONAsync()
        expect(json[4]).to.deep.equal(details.rootNode)
      })
    })
  })

  it('should have DT attributes on transaction end', function (done) {
    agent.config.distributed_tracing.enabled = true
    agent.config.primary_application_id = 'test'
    agent.config.account_id = 1
    helper.runInTransaction(agent, function (tx) {
      tx.end()
      const attributes = tx.trace.intrinsics
      expect(attributes.traceId).to.equal(tx.traceId)
      expect(attributes.guid).to.equal(tx.id)
      expect(attributes.priority).to.equal(tx.priority)
      expect(attributes.sampled).to.equal(tx.sampled)
      expect(attributes.parentId).to.be.undefined
      expect(attributes.parentSpanId).to.be.undefined
      expect(tx.sampled).to.equal(true)
      expect(tx.priority).to.be.greaterThan(1)
      done()
    })
  })

  it('should have DT parent attributes on payload accept', function () {
    agent.config.distributed_tracing.enabled = true
    agent.config.primary_application_id = 'test'
    agent.config.account_id = 1
    helper.runInTransaction(agent, function (tx) {
      const payload = tx._createDistributedTracePayload().text()
      tx.isDistributedTrace = null
      tx._acceptDistributedTracePayload(payload)
      tx.end()
      const attributes = tx.trace.intrinsics
      expect(attributes.traceId).to.equal(tx.traceId)
      expect(attributes.guid).to.equal(tx.id)
      expect(attributes.priority).to.equal(tx.priority)
      expect(attributes.sampled).to.equal(tx.sampled)
      expect(attributes['parent.type']).to.equal('App')
      expect(attributes['parent.app']).to.equal(agent.config.primary_application_id)
      expect(attributes['parent.account']).to.equal(agent.config.account_id)
      expect(attributes.parentId).to.be.undefined
      expect(attributes.parentSpanId).to.be.undefined
      expect(tx.sampled).to.equal(true)
      expect(tx.priority).to.be.greaterThan(1)
    })
  })

  it('should generate span events', function () {
    agent.config.span_events.enabled = true
    agent.config.distributed_tracing.enabled = true

    const transaction = new Transaction(agent)

    const trace = transaction.trace
    const child1 = (transaction.baseSegment = trace.add('test'))
    child1.start()
    const child2 = child1.add('nested')
    child2.start()
    child1.end()
    child2.end()
    trace.root.end()
    transaction.end()
    trace.generateSpanEvents()

    const events = agent.spanEventAggregator.getEvents()
    const nested = events[0]
    const testSpan = events[1]
    expect(nested).to.have.property('intrinsics')
    expect(testSpan).to.have.property('intrinsics')

    expect(nested.intrinsics).to.have.property('parentId', testSpan.intrinsics.guid)
    expect(nested.intrinsics).to.have.property('category', 'generic')
    expect(nested.intrinsics).to.have.property('priority', transaction.priority)
    expect(nested.intrinsics).to.have.property('transactionId', transaction.id)
    expect(nested.intrinsics).to.have.property('sampled', transaction.sampled)
    expect(nested.intrinsics).to.have.property('name', 'nested')
    expect(nested.intrinsics).to.have.property('traceId', transaction.traceId)
    expect(nested.intrinsics).to.have.property('timestamp')

    expect(testSpan.intrinsics).to.have.property('parentId', null)
    expect(testSpan.intrinsics).to.have.property('nr.entryPoint').and.be.true
    expect(testSpan.intrinsics).to.have.property('category', 'generic')
    expect(testSpan.intrinsics).to.have.property('priority', transaction.priority)
    expect(testSpan.intrinsics).to.have.property('transactionId', transaction.id)
    expect(testSpan.intrinsics).to.have.property('sampled', transaction.sampled)
    expect(testSpan.intrinsics).to.have.property('name', 'test')
    expect(testSpan.intrinsics).to.have.property('traceId', transaction.traceId)
    expect(testSpan.intrinsics).to.have.property('timestamp')
  })

  it('should not generate span events on end if span_events is disabled', function () {
    agent.config.span_events.enabled = false
    agent.config.distributed_tracing.enabled = true

    const transaction = new Transaction(agent)

    const trace = transaction.trace
    const child1 = trace.add('test')
    child1.start()
    const child2 = child1.add('nested')
    child2.start()
    child1.end()
    child2.end()
    trace.root.end()
    transaction.end()

    const events = agent.spanEventAggregator.getEvents()
    expect(events.length).to.equal(0)
  })

  it('should not generate span events on end if distributed_tracing is off', function () {
    agent.config.span_events.enabled = true
    agent.config.distributed_tracing.enabled = false

    const transaction = new Transaction(agent)

    const trace = transaction.trace
    const child1 = trace.add('test')
    child1.start()
    const child2 = child1.add('nested')
    child2.start()
    child1.end()
    child2.end()
    trace.root.end()
    transaction.end()

    const events = agent.spanEventAggregator.getEvents()
    expect(events.length).to.equal(0)
  })

  it('should not generate span events on end if transaction is not sampled', function () {
    agent.config.span_events.enabled = true
    agent.config.distributed_tracing.enabled = false

    const transaction = new Transaction(agent)

    const trace = transaction.trace
    const child1 = trace.add('test')
    child1.start()
    const child2 = child1.add('nested')
    child2.start()
    child1.end()
    child2.end()
    trace.root.end()

    transaction.priority = 0
    transaction.sampled = false
    transaction.end()

    const events = agent.spanEventAggregator.getEvents()
    expect(events.length).to.equal(0)
  })

  it('parent.* attributes should be present on generated spans', function () {
    // Setup DT
    const encKey = 'gringletoes'
    agent.config.encoding_key = encKey
    agent.config.attributes.enabled = true
    agent.config.distributed_tracing.enabled = true
    agent.config.trusted_account_key = 111

    const dtInfo = {
      ty: 'App', // type
      ac: 111, // accountId
      ap: 222, // appId
      tx: 333, // transactionId
      tr: 444, // traceId
      pr: 1, // priority
      sa: true, // sampled
      // timestamp, if in the future, duration will always be 0
      ti: Date.now() + 10000
    }
    const dtPayload = new DTPayload(dtInfo)
    const headers = { [NEWRELIC_TRACE_HEADER]: dtPayload.httpSafe() }
    const transaction = new Transaction(agent)
    transaction.sampled = true

    // Get the parent attributes on the transaction
    transaction.acceptDistributedTraceHeaders('HTTP', headers)

    // Create at least one segment
    const trace = new Trace(transaction)
    const child = (transaction.baseSegment = trace.add('test'))
    child.start()
    child.end()

    // This should add the parent attributes onto a child span event
    trace.generateSpanEvents()

    // Test that a child span event has the attributes
    const attrs = child.attributes.get(DESTINATIONS.SPAN_EVENT)
    expect(attrs).deep.equal({
      'parent.type': 'App',
      'parent.app': 222,
      'parent.account': 111,
      'parent.transportType': 'HTTP',
      'parent.transportDuration': 0
    })
  })

  it('should send host display name on transaction when set by user', function () {
    agent.config.attributes.enabled = true
    agent.config.process_host.display_name = 'test-value'

    const trace = new Trace(new Transaction(agent))

    expect(trace.attributes.get(DESTINATIONS.TRANS_TRACE)).deep.equal({
      'host.displayName': 'test-value'
    })
  })

  it('should send host display name attribute on span', function () {
    agent.config.attributes.enabled = true
    agent.config.distributed_tracing.enabled = true
    agent.config.process_host.display_name = 'test-value'
    const transaction = new Transaction(agent)
    transaction.sampled = true

    const trace = new Trace(transaction)

    // add a child segment
    const child = (transaction.baseSegment = trace.add('test'))
    child.start()
    child.end()

    trace.generateSpanEvents()

    expect(child.attributes.get(DESTINATIONS.SPAN_EVENT)).deep.equal({
      'host.displayName': 'test-value'
    })
  })

  it('should not send host display name when not set by user', function () {
    const trace = new Trace(new Transaction(agent))

    expect(trace.attributes.get(DESTINATIONS.TRANS_TRACE)).deep.equal({})
  })

  describe('when inserting segments', function () {
    let trace = null
    let transaction = null

    beforeEach(function () {
      transaction = new Transaction(agent)
      trace = transaction.trace
    })

    it('should allow child segments on a trace', function () {
      expect(function () {
        trace.add('Custom/Test17/Child1')
      }).not.throws()
    })

    it('should return the segment', function () {
      let segment
      expect(function () {
        segment = trace.add('Custom/Test18/Child1')
      }).not.throws()
      expect(segment).instanceof(Segment)
    })

    it('should call a function associated with the segment', function (done) {
      const segment = trace.add('Custom/Test18/Child1', function () {
        return done()
      })

      segment.end()
      transaction.end()
    })

    it('should report total time', function () {
      trace.setDurationInMillis(40, 0)
      const child = trace.add('Custom/Test18/Child1')
      child.setDurationInMillis(27, 0)
      let seg = child.add('UnitTest')
      seg.setDurationInMillis(9, 1)
      seg = child.add('UnitTest1')
      seg.setDurationInMillis(13, 1)
      seg = child.add('UnitTest2')
      seg.setDurationInMillis(9, 16)
      seg = child.add('UnitTest2')
      seg.setDurationInMillis(14, 16)
      expect(trace.getTotalTimeDurationInMillis()).equal(48)
    })

    it('should report total time on branched traces', function () {
      trace.setDurationInMillis(40, 0)
      const child = trace.add('Custom/Test18/Child1')
      child.setDurationInMillis(27, 0)
      const seg1 = child.add('UnitTest')
      seg1.setDurationInMillis(9, 1)
      let seg = child.add('UnitTest1')
      seg.setDurationInMillis(13, 1)
      seg = seg1.add('UnitTest2')
      seg.setDurationInMillis(9, 16)
      seg = seg1.add('UnitTest2')
      seg.setDurationInMillis(14, 16)
      expect(trace.getTotalTimeDurationInMillis()).equal(48)
    })

    it('should report the expected trees for trees with uncollected segments', () => {
      const expectedTrace = [
        0,
        27,
        'Root',
        { nr_exclusive_duration_millis: 3 },
        [
          [
            1,
            10,
            'first',
            { nr_exclusive_duration_millis: 9 },
            [[16, 25, 'first-first', { nr_exclusive_duration_millis: 9 }, []]]
          ],
          [
            1,
            14,
            'second',
            { nr_exclusive_duration_millis: 13 },
            [
              [16, 25, 'second-first', { nr_exclusive_duration_millis: 9 }, []],
              [16, 25, 'second-second', { nr_exclusive_duration_millis: 9 }, []]
            ]
          ]
        ]
      ]

      trace.setDurationInMillis(40, 0)
      const child = trace.add('Root')
      child.setDurationInMillis(27, 0)
      const seg1 = child.add('first')
      seg1.setDurationInMillis(9, 1)
      const seg2 = child.add('second')
      seg2.setDurationInMillis(13, 1)
      let seg = seg1.add('first-first')
      seg.setDurationInMillis(9, 16)
      seg = seg1.add('first-second')
      seg.setDurationInMillis(14, 16)
      seg._collect = false
      seg = seg2.add('second-first')
      seg.setDurationInMillis(9, 16)
      seg = seg2.add('second-second')
      seg.setDurationInMillis(9, 16)

      trace.end()

      expect(child.toJSON()).deep.equal(expectedTrace)
    })

    it('should report the expected trees for branched trees', function () {
      const expectedTrace = [
        0,
        27,
        'Root',
        { nr_exclusive_duration_millis: 3 },
        [
          [
            1,
            10,
            'first',
            { nr_exclusive_duration_millis: 9 },
            [
              [16, 25, 'first-first', { nr_exclusive_duration_millis: 9 }, []],
              [16, 30, 'first-second', { nr_exclusive_duration_millis: 14 }, []]
            ]
          ],
          [
            1,
            14,
            'second',
            { nr_exclusive_duration_millis: 13 },
            [
              [16, 25, 'second-first', { nr_exclusive_duration_millis: 9 }, []],
              [16, 25, 'second-second', { nr_exclusive_duration_millis: 9 }, []]
            ]
          ]
        ]
      ]
      trace.setDurationInMillis(40, 0)
      const child = trace.add('Root')
      child.setDurationInMillis(27, 0)
      const seg1 = child.add('first')
      seg1.setDurationInMillis(9, 1)
      const seg2 = child.add('second')
      seg2.setDurationInMillis(13, 1)
      let seg = seg1.add('first-first')
      seg.setDurationInMillis(9, 16)
      seg = seg1.add('first-second')
      seg.setDurationInMillis(14, 16)
      seg = seg2.add('second-first')
      seg.setDurationInMillis(9, 16)
      seg = seg2.add('second-second')
      seg.setDurationInMillis(9, 16)

      trace.end()

      expect(child.toJSON()).deep.equal(expectedTrace)
    })

    it('should measure exclusive time vs total time at each level of the graph', () => {
      const child = trace.add('Custom/Test18/Child1')

      trace.setDurationInMillis(42)
      child.setDurationInMillis(22, 0)

      expect(trace.getExclusiveDurationInMillis()).equal(20)
    })

    it('should accurately sum overlapping segments', function () {
      trace.setDurationInMillis(42)

      const now = Date.now()

      const child1 = trace.add('Custom/Test19/Child1')
      child1.setDurationInMillis(22, now)

      // add another child trace completely encompassed by the first
      const child2 = trace.add('Custom/Test19/Child2')
      child2.setDurationInMillis(5, now + 5)

      // add another that starts within the first range but that extends beyond
      const child3 = trace.add('Custom/Test19/Child3')
      child3.setDurationInMillis(22, now + 11)

      // add a final child that's entirely disjoint
      const child4 = trace.add('Custom/Test19/Child4')
      child4.setDurationInMillis(4, now + 35)

      expect(trace.getExclusiveDurationInMillis()).equal(5)
    })

    it('should accurately sum overlapping subtrees', function () {
      trace.setDurationInMillis(42)

      const now = Date.now()

      // create a long child on its own
      const child1 = trace.add('Custom/Test20/Child1')
      child1.setDurationInMillis(33, now)

      // add another, short child as a sibling
      const child2 = child1.add('Custom/Test20/Child2')
      child2.setDurationInMillis(5, now)

      // add two disjoint children of the second segment encompassed by the first segment
      const child3 = child2.add('Custom/Test20/Child3')
      child3.setDurationInMillis(11, now)

      const child4 = child2.add('Custom/Test20/Child3')
      child4.setDurationInMillis(11, now + 16)

      expect(trace.getExclusiveDurationInMillis()).equal(9)
      expect(child4.getExclusiveDurationInMillis()).equal(11)
      expect(child3.getExclusiveDurationInMillis()).equal(11)
      expect(child2.getExclusiveDurationInMillis()).equal(0)
      expect(child1.getExclusiveDurationInMillis()).equal(11)
    })

    it('should accurately sum partially overlapping segments', function () {
      trace.setDurationInMillis(42)

      const now = Date.now()

      const child1 = trace.add('Custom/Test20/Child1')
      child1.setDurationInMillis(22, now)

      // add another child trace completely encompassed by the first
      const child2 = trace.add('Custom/Test20/Child2')
      child2.setDurationInMillis(5, now + 5)

      /* add another that starts simultaneously with the first range but
       * that extends beyond
       */
      const child3 = trace.add('Custom/Test20/Child3')
      child3.setDurationInMillis(33, now)

      expect(trace.getExclusiveDurationInMillis()).equal(9)
    })

    it('should accurately sum partially overlapping, open-ranged segments', function () {
      trace.setDurationInMillis(42)

      const now = Date.now()

      const child1 = trace.add('Custom/Test21/Child1')
      child1.setDurationInMillis(22, now)

      // add a range that starts at the exact end of the first
      const child2 = trace.add('Custom/Test21/Child2')
      child2.setDurationInMillis(11, now + 22)

      expect(trace.getExclusiveDurationInMillis()).equal(9)
    })

    it('should be limited to 900 children', function () {
      // They will be tagged as _collect = false after the limit runs out.
      for (let i = 0; i < 950; ++i) {
        const segment = trace.add(i.toString(), noop)
        if (i < 900) {
          expect(segment._collect).equal(true)
        } else {
          expect(segment._collect).equal(false)
        }
      }

      expect(trace.root.children.length).equal(950)
      expect(transaction._recorders.length).equal(950)
      trace.segmentCount = 0
      trace.root.children = []
      trace.recorders = []

      function noop() {}
    })
  })
})

tap.test('should set URI to null when request.uri attribute is excluded globally', async (t) => {
  const URL = '/test'

  const agent = helper.loadMockedAgent({
    attributes: {
      exclude: ['request.uri']
    }
  })

  t.teardown(() => {
    helper.unloadAgent(agent)
  })

  const transaction = new Transaction(agent)
  transaction.url = URL
  transaction.verb = 'GET'

  const trace = transaction.trace
  trace.generateJSON = util.promisify(trace.generateJSON)

  trace.end()

  const traceJSON = await trace.generateJSON()
  const { 3: requestUri } = traceJSON
  t.notOk(requestUri)
  t.end()
})

tap.test('should set URI to null when request.uri attribute is exluded from traces', async (t) => {
  const URL = '/test'

  const agent = helper.loadMockedAgent({
    transaction_tracer: {
      attributes: {
        exclude: ['request.uri']
      }
    }
  })

  t.teardown(() => {
    helper.unloadAgent(agent)
  })

  const transaction = new Transaction(agent)
  transaction.url = URL
  transaction.verb = 'GET'

  const trace = transaction.trace
  trace.generateJSON = util.promisify(trace.generateJSON)

  trace.end()

  const traceJSON = await trace.generateJSON()
  const { 3: requestUri } = traceJSON
  t.notOk(requestUri)
  t.end()
})

tap.test('should set URI to /Unknown when URL is not known/set on transaction', async (t) => {
  const agent = helper.loadMockedAgent()

  t.teardown(() => {
    helper.unloadAgent(agent)
  })

  const transaction = new Transaction(agent)
  const trace = transaction.trace
  trace.generateJSON = util.promisify(trace.generateJSON)

  trace.end()

  const traceJSON = await trace.generateJSON()
  const { 3: requestUri } = traceJSON
  t.equal(requestUri, '/Unknown')
  t.end()
})

async function makeTrace(agent) {
  const DURATION = 33
  const URL = '/test?test=value'
  agent.config.attributes.enabled = true
  agent.config.attributes.include = ['request.parameters.*']
  agent.config.emit('attributes.include')

  const transaction = new Transaction(agent)
  transaction.trace.attributes.addAttribute(DESTINATIONS.TRANS_COMMON, 'request.uri', URL)
  transaction.url = URL
  transaction.verb = 'GET'

  transaction.timer.setDurationInMillis(DURATION)

  const trace = transaction.trace

  // promisifying `trace.generateJSON` so tests do not have to call done
  // and instead use async/await
  trace.generateJSONAsync = util.promisify(trace.generateJSON)
  const start = trace.root.timer.start
  expect(start, "root segment's start time").above(0)
  trace.setDurationInMillis(DURATION, 0)

  const web = trace.root.add(URL)
  transaction.baseSegment = web
  transaction.finalizeNameFromUri(URL, 200)
  // top-level element will share a duration with the quasi-ROOT node
  web.setDurationInMillis(DURATION, 0)

  const db = web.add('Database/statement/AntiSQL/select/getSome')
  db.setDurationInMillis(14, 3)

  const memcache = web.add('Datastore/operation/Memcache/lookup')
  memcache.setDurationInMillis(20, 8)

  trace.end()

  /*
   * Segment data repeats the outermost data, nested, with the scope for the
   * outermost version having its scope always set to 'ROOT'. The null bits
   * are parameters, which are optional, and so far, unimplemented for Node.
   */
  const rootSegment = [
    0,
    DURATION,
    'ROOT',
    { nr_exclusive_duration_millis: 0 },
    [
      [
        0,
        DURATION,
        'WebTransaction/NormalizedUri/*',
        {
          'request.uri': '/test?test=value',
          'request.parameters.test': 'value',
          'nr_exclusive_duration_millis': 8
        },
        [
          // TODO: ensure that the ordering is correct WRT start time
          db.toJSON(),
          memcache.toJSON()
        ]
      ]
    ]
  ]

  const rootNode = [
    trace.root.timer.start / 1000,
    {},
    { nr_flatten_leading: false },
    rootSegment,
    {
      agentAttributes: {
        'request.uri': '/test?test=value',
        'request.parameters.test': 'value'
      },
      userAttributes: {},
      intrinsics: {}
    },
    [] // FIXME: parameter groups
  ]

  const encoded = await codecEncodeAsync(rootNode)
  return {
    transaction,
    trace,
    rootSegment,
    rootNode,
    expectedEncoding: [
      0,
      DURATION,
      'WebTransaction/NormalizedUri/*', // scope
      '/test', // URI path
      encoded, // compressed segment / segment data
      transaction.id, // guid
      null, // reserved, always NULL
      false, // FIXME: RUM2 session persistence, not worrying about it for now
      null, // FIXME: xraysessionid
      null // syntheticsResourceId
    ]
  }
  /*
  codec.encode(rootNode, function(err, encoded) {
    if (err) {
      return callback(err)
    }

    callback(null, {
      transaction,
      trace,
      rootSegment,
      rootNode,
      expectedEncoding: [
        0,
        DURATION,
        'WebTransaction/NormalizedUri/*', // scope
        '/test',  // URI path
        encoded,  // compressed segment / segment data
        transaction.id, // guid
        null,     // reserved, always NULL
        false,    // FIXME: RUM2 session persistence, not worrying about it for now
        null,     // FIXME: xraysessionid
        null      // syntheticsResourceId
      ]
    })
  })*/
}

tap.test('infinite tracing', (t) => {
  t.autoend()

  const VALID_HOST = 'infinite-tracing.test'
  const VALID_PORT = '443'

  let agent = null

  t.beforeEach(() => {
    agent = helper.loadMockedAgent({
      distributed_tracing: {
        enabled: true
      },
      span_events: {
        enabled: true
      },
      infinite_tracing: {
        trace_observer: {
          host: VALID_HOST,
          port: VALID_PORT
        }
      }
    })
  })

  t.afterEach(() => {
    helper.unloadAgent(agent)
  })

  t.test('should generate spans if infinite configured, transaction not sampled', (t) => {
    const spy = sinon.spy(agent.spanEventAggregator, 'addSegment')

    const transaction = new Transaction(agent)
    transaction.priority = 0
    transaction.sampled = false

    addTwoSegments(transaction)

    transaction.trace.generateSpanEvents()

    t.equal(spy.callCount, 2)

    t.end()
  })

  t.test('should not generate spans if infinite not configured, transaction not sampled', (t) => {
    agent.config.infinite_tracing.trace_observer.host = ''

    const spy = sinon.spy(agent.spanEventAggregator, 'addSegment')

    const transaction = new Transaction(agent)
    transaction.priority = 0
    transaction.sampled = false

    addTwoSegments(transaction)

    transaction.trace.generateSpanEvents()

    t.equal(spy.callCount, 0)

    t.end()
  })
})

function addTwoSegments(transaction) {
  const trace = transaction.trace
  const child1 = (transaction.baseSegment = trace.add('test'))
  child1.start()
  const child2 = child1.add('nested')
  child2.start()
  child1.end()
  child2.end()
  trace.root.end()
}
