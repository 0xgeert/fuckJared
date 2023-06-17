/**
 * Tracks Jared's bot swaps and sends out tweets for big wins
 * Also does a recaps once every 12 hours
 *
 * Only tracking Univ2 style pools with WETH as one of the tokens
 */

const Web3 = require("web3")
const Promise = require("bluebird")
const _ = require("lodash")
const Decimal = require("decimal.js")

require("dotenv").config({
  path: require("path").resolve(__dirname, "./.env"),
})
if (!process.env.RPC_MAINNET_HTTP) throw new Error(`.env file not supplied?`)

const erc20ABI = require("./abis/erc20.json")
const pairABI = require("./abis/pair.json")

// const JARED_ADDRESS = "0xae2fc483527b8ef99eb5d9b44875f005ba1fae13"
const JARED_ADDRESS_BOT_ASTOPIC = "0x0000000000000000000000006b75d8AF000000e20B7a7DDf000Ba900b4009A80"
const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
const WETH_DECIMAL = new Decimal(10).pow(18)

const provider = new Web3.providers.HttpProvider(process.env.RPC_MAINNET_HTTP)
const web3 = new Web3(provider)
const swapABI = getSwapABI()

const poolMap = {}
const tokenMap = {}

let ethTotal = new Decimal(0)
async function processSwapEventsForBlocks(events) {
  // Group by block number and pool address
  // This means that all sandwiches must occur in the same group.
  const groupedEvents = _.groupBy(events, event => `${event.blockNumber}-${event.address}`)

  const keys = _.keys(groupedEvents)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const [block, poolAddress] = key.split("-")

    let poolInfo
    try {
      poolInfo = await getPoolAndTokenInfo(poolAddress)
      if (!poolInfo) continue // not interested in this pool
    } catch (err) {
      // edge case: overflow somewhere in web3 lib. Dont care
      continue
    }

    let ethCapturedInBlockToken = new Decimal(0)
    const swaps = groupedEvents[key]

    _.each(swaps, swap => {
      try {
        const { amount0In, amount1In, amount0Out, amount1Out } = web3.eth.abi.decodeLog(swapABI, swap.data, swap.topics.slice(1))
        if (poolInfo.isEthToken0) {
          ethCapturedInBlockToken = ethCapturedInBlockToken.add(new Decimal(amount0Out).div(WETH_DECIMAL)).sub(new Decimal(amount0In).div(WETH_DECIMAL)) // amount0In is the amount of WETH bot sends to pool, amount0Out is the amount of WETH bot receives from pool
        } else {
          ethCapturedInBlockToken = ethCapturedInBlockToken.add(new Decimal(amount1Out).div(WETH_DECIMAL)).sub(new Decimal(amount1In).div(WETH_DECIMAL)) // amount1In is the amount of WETH bot sends to pool, amount1Out is the amount of WETH bot receives from pool
        }
      } catch (err) {
        // some decoding error -> don't care
        return
      }
    })

    ethTotal = ethTotal.add(ethCapturedInBlockToken)

    if (ethCapturedInBlockToken.gt(1)) {
      // Tweet it out
      console.log(`Jared did a large one: ${(+ethCapturedInBlockToken.toString()).toFixed(2)} ETH profit in block: ${block} against token ${poolInfo.token.name}/ $${poolInfo.token.symbol} (${poolInfo.token.address}) / (Total today: ${(+ethTotal.toString()).toFixed(2)} ETH )`)
    }
  }
}

start()
async function start() {
  // From current block to midnight
  const block = await web3.eth.getBlock()
  const blockTime = new Date(parseInt(block.timestamp) * 1000)
  const midnight = Math.floor(blockTime / (86400 * 1000)) * (86400 * 1000) // in UTC
  const blocksToBootstrap = Math.floor(Math.floor((blockTime.getTime() - midnight) / 1000) / 12) // 12 seconds per block
  let blockStart = parseInt(block.number) - blocksToBootstrap // start at past midnight UTC

  // Bootstrap blocks from midnight to current block
  const bootstapPromises = []
  const chunks = _.chunk(_.range(blockStart, block.number), 100)
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const events = await web3.eth.getPastLogs({
      fromBlock: chunk[0],
      toBlock: chunk[chunk.length - 1],
      topics: [SWAP_TOPIC, JARED_ADDRESS_BOT_ASTOPIC, JARED_ADDRESS_BOT_ASTOPIC], // swap where Jared bot was the sender as well ass-receiver
    })

    // TODO: limiter
    bootstapPromises.push(processSwapEventsForBlocks(events, true))
  }

  await Promise.all(bootstapPromises)

  let currentBlock = block.number
  // run indefinitely
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

async function getPoolAndTokenInfo(poolAddress) {
  // Lookup pool and token info
  if (poolMap[poolAddress]) return poolMap[poolAddress]

  //create web3 contract instance using pairABI
  const pairContract = new web3.eth.Contract(pairABI, poolAddress)
  const { token0, token1 } = await Promise.props({
    token0: pairContract.methods.token0().call(),
    token1: pairContract.methods.token1().call(),
  })

  // Not interested in pools that are not bound to WETH
  if (!(token0 === WETH || token1 === WETH)) return null

  const isEthToken0 = token0 === WETH
  const tokenAddress = isEthToken0 ? token1 : token0
  let token = tokenMap[tokenAddress]

  // Get token info
  if (!token) {
    const tokenContract = new web3.eth.Contract(erc20ABI, tokenAddress)

    const tokenInfo = await Promise.props({
      symbol: tokenContract.methods.symbol().call(),
      name: tokenContract.methods.name().call(),
    })
    token = { address: tokenAddress, ...tokenInfo }
    tokenMap[tokenAddress] = token
  }

  poolMap[poolAddress] = { poolAddress, token, isEthToken0 }
  return poolMap[poolAddress]
}
