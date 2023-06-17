/**
 * Tracks Jared's bot swaps and sends out tweets for big wins
 * Also does a recaps once every 12 hours
 *
 * Fuck Jared!
 */

const Web3 = require("web3")
const Promise = require("bluebird")
const _ = require("lodash")

require("dotenv").config({
  path: require("path").resolve(__dirname, "./.env"),
})
if (!process.env.RPC_MAINNET_HTTP) throw new Error(`.env file not supplied?`)

// const JARED_ADDRESS = "0xae2fc483527b8ef99eb5d9b44875f005ba1fae13"
const JARED_ADDRESS_BOT_ASTOPIC = "0x0000000000000000000000006b75d8AF000000e20B7a7DDf000Ba900b4009A80"
const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"

const provider = new Web3.providers.HttpProvider(process.env.RPC_MAINNET_HTTP)
const web3 = new Web3(provider)
const swapABI = getSwapABI()

start()
async function start() {
  //
  // From current block to midnight
  const block = await web3.eth.getBlock()
  const blockTime = new Date(parseInt(block.timestamp) * 1000)
  const midnight = Math.floor(blockTime / (86400 * 1000)) * (86400 * 1000) // in UTC
  const blocksToBootstrap = Math.floor(Math.floor((blockTime.getTime() - midnight) / 1000) / 12) // 12 seconds per block
  let blockStart = parseInt(block.number) - blocksToBootstrap // start at past midnight UTC

  // Bootstrap blocks from midnight to current block
  const chunks = _.chunk(_.range(blockStart, block.number), 100)
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const events = await web3.eth.getPastLogs({
      fromBlock: chunk[0],
      toBlock: chunk[chunk.length - 1],
      topics: [SWAP_TOPIC, JARED_ADDRESS_BOT_ASTOPIC, JARED_ADDRESS_BOT_ASTOPIC], // swap where Jared bot was the sender as well ass-receiver
    })
    processSwapEventsForBlocks(events)
  }

  let currentBlock = block.number
  while (true) {
    const newBlockNumber = await web3.eth.getBlockNumber()
    if (currentBlock === newBlockNumber) {
      await Promise.delay(1000)
      continue
    }
    const events = await web3.eth.getPastLogs({
      fromBlock: currentBlock,
      toBlock: newBlockNumber,
      topics: [SWAP_TOPIC, JARED_ADDRESS_BOT_ASTOPIC, JARED_ADDRESS_BOT_ASTOPIC],
    })
    processSwapEventsForBlocks(events)
    currentBlock = newBlockNumber
  }
}

async function processSwapEventsForBlocks(events) {
  const tokens = _.uniq(_.map(events, "address"))

  const sandwiches = []
  let failed = 0

  const groupedEvents = _.groupBy(events, event => `${event.blockNumber}-${event.address}`)
  _.each(groupedEvents, (events, key) => {
    // Some simplifications:
    // - we expect 1 front leg and 2 tx afterwards a back leg
    // - everything else is skipped
    // Since Jared mev-bundles this stuff this should be pretty accurate. When things don't line up, he probably lost. We could track later by looking at the txs and see if they were successful or not.
    let isFrontLeg = false
    let frontLeg = null
    for (let i = 0; i < events.length; i++) {
      const event = events[i]
      if (!isFrontLeg) {
        // TODO: should check if this is a buy. If it's a sell, we should skip
        frontLeg = event
        isFrontLeg = true
      } else {
        if (event.blockNumber === frontLeg.blockNumber && frontLeg.transactionIndex === event.transactionIndex - 2) {
          // back leg
          sandwiches.push({ frontLeg, backLeg: event })
        } else {
          failed++
        }
        isFrontLeg = false
        frontLeg = null
      }
    }
  })

  console.log(events.length, sandwiches.length, failed)
}

function getSwapABI() {
  return [
    {
      indexed: true,
      internalType: "address",
      name: "sender",
      type: "address",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "amount0In",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "amount1In",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "amount0Out",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "amount1Out",
      type: "uint256",
    },
    {
      indexed: true,
      internalType: "address",
      name: "to",
      type: "address",
    },
  ]
}
