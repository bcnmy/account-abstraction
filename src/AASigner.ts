import { BigNumber, Bytes, ethers, Signer, Event } from 'ethers'
import { BaseProvider, Provider, TransactionRequest } from '@ethersproject/providers'
import { Deferrable, resolveProperties } from '@ethersproject/properties'
import { SimpleWallet, SimpleWallet__factory, EntryPoint, EntryPoint__factory } from '../typechain'
import { BytesLike, hexValue } from '@ethersproject/bytes'
import { TransactionResponse } from '@ethersproject/abstract-provider'
import { fillAndSign, getRequestId } from '../test/UserOp'
import { UserOperation } from '../test/UserOperation'
import { TransactionReceipt } from '@ethersproject/abstract-provider/src.ts/index'
import { clearInterval } from 'timers'
import { Create2Factory } from './Create2Factory'
import { getCreate2Address, hexConcat, keccak256 } from 'ethers/lib/utils'
import { AddressZero, HashZero } from '../test/testutils'

export type SendUserOp = (userOp: UserOperation) => Promise<TransactionResponse | undefined>

export const debug = process.env.DEBUG != null

/**
 * send a request using rpc.
 *
 * @param provider - rpc provider that supports "eth_sendUserOperation"
 */
export function rpcUserOpSender (provider: ethers.providers.JsonRpcProvider, entryPointAddress: string): SendUserOp {
  console.log('rpcUserOpSender')
  let chainId: number

  return async function (userOp) {
    if (debug) {
      console.log('sending eth_sendUserOperation', {
        ...userOp,
        initCode: (userOp.initCode ?? '').length,
        callData: (userOp.callData ?? '').length
      }, entryPointAddress)
    }
    if (chainId === undefined) {
      chainId = await provider.getNetwork().then(net => net.chainId)
    }

    const cleanUserOp = Object.keys(userOp).map(key => {
      let val = (userOp as any)[key]
      if (typeof val !== 'string' || !val.startsWith('0x')) {
        val = hexValue(val)
      }
      return [key, val]
    })
      .reduce((set, [k, v]) => ({ ...set, [k]: v }), {})
    await provider.send('eth_sendUserOperation', [cleanUserOp, entryPointAddress]).catch(e => {
      throw e.error ?? e
    })
    return undefined
  }
}

interface QueueSendUserOp extends SendUserOp {
  lastQueueUpdate: number
  queueSize: number
  queue: { [sender: string]: UserOperation[] }
  push: () => Promise<void>
  setInterval: (intervalMs: number) => void
  cancelInterval: () => void

  _cancelInterval: any
}

/**
 * a SendUserOp that queue requests. need to call sendQueuedUserOps to create a bundle and send them.
 * the returned object handles the queue of userops and also interval control.
 */
export function queueUserOpSender (entryPointAddress: string, signer: Signer, intervalMs = 3000): QueueSendUserOp {
  console.log('rpcUserOpSender')
  const entryPoint = EntryPoint__factory.connect(entryPointAddress, signer)

  const ret = async function (userOp: UserOperation) {
    if (ret.queue[userOp.sender] == null) {
      ret.queue[userOp.sender] = []
    }
    ret.queue[userOp.sender].push(userOp)
    ret.lastQueueUpdate = Date.now()
    ret.queueSize++
  } as QueueSendUserOp

  ret.queue = {}
  ret.push = async function () {
    await sendQueuedUserOps(ret, entryPoint)
  }
  ret.setInterval = function (intervalMs: number) {
    ret.cancelInterval()
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    ret._cancelInterval = setInterval(ret.push, intervalMs)
  }
  ret.cancelInterval = function () {
    if (ret._cancelInterval != null) {
      clearInterval(ret._cancelInterval)
      ret._cancelInterval = null
    }
  }

  if (intervalMs != null) {
    ret.setInterval(intervalMs)
  }

  return ret
}

/**
 * create a bundle from the queue and send it to the entrypoint.
 * NOTE: only a single request from a given sender can be put into a bundle.
 * @param queue
 * @param entryPoint
 */

let sending = false

// after that much time with no new TX, send whatever you can.
const IDLE_TIME = 5000

// when reaching this theshold, don't wait anymore and send a bundle
const BUNDLE_SIZE_IMMEDIATE = 3

async function sendQueuedUserOps (queueSender: QueueSendUserOp, entryPoint: EntryPoint): Promise<void> {
  console.log('sendQueuedUserOps')
  if (sending) {
    console.log('sending in progress. waiting')
    return
  }
  sending = true
  try {
    if (queueSender.queueSize < BUNDLE_SIZE_IMMEDIATE || queueSender.lastQueueUpdate + IDLE_TIME > Date.now()) {
      console.log('queue too small/too young. waiting')
      return
    }
    const ops: UserOperation[] = []
    const queue = queueSender.queue
    Object.keys(queue).forEach(sender => {
      const op = queue[sender].shift()
      if (op != null) {
        ops.push(op)
        queueSender.queueSize--
      }
    })
    if (ops.length === 0) {
      console.log('no ops to send')
      return
    }
    const signer = await (entryPoint.provider as any).getSigner().getAddress()
    console.log('==== sending batch of ', ops.length)
    const ret = await entryPoint.handleOps(ops, signer, { maxPriorityFeePerGas: 2e9 })
    console.log('handleop tx=', ret.hash)
    const rcpt = await ret.wait()
    console.log('events=', rcpt.events!.map(e => ({ name: e.event, args: e.args })))
  } finally {
    sending = false
  }
}

/**
 * send UserOp using handleOps, but locally.
 * for testing: instead of connecting through RPC to a remote host, directly send the transaction
 * @param entryPointAddress the entryPoint address to use.
 * @param signer ethers provider to send the request (must have eth balance to send)
 * @param beneficiary the account to receive the payment (from wallet/paymaster). defaults to the signer's address
 */
export function localUserOpSender (entryPointAddress: string, signer: Signer, beneficiary?: string): SendUserOp {
  console.log('localUserOpSender')

  const entryPoint = EntryPoint__factory.connect(entryPointAddress, signer)
  return async function (userOp) {
    if (debug) {
      console.log('ever here in debug?')
      console.log('sending transaction ', {
        ...userOp,
        initCode: userOp.initCode.length <= 2 ? userOp.initCode : `<len=${userOp.initCode.length}>`
      })
    }
    const gasLimit = BigNumber.from(userOp.preVerificationGas).add(userOp.verificationGasLimit).add(userOp.callGasLimit)
    console.log('calc gaslimit=', gasLimit.toString())
    try {
      const ret = await entryPoint.handleOps([userOp], beneficiary ?? await signer.getAddress(), {
        gasLimit: gasLimit,
        maxPriorityFeePerGas: userOp.maxPriorityFeePerGas,
        maxFeePerGas: userOp.maxFeePerGas
      })
      console.log('tx sent')

      await ret.wait()
    } catch (err) {
      console.log('localUserOpSender error ', err)
    }
    return undefined
  }
}

export class AAProvider extends BaseProvider {
  private readonly entryPoint: EntryPoint

  constructor (entryPointAddress: string, provider: Provider) {
    console.log('AA provider constructor')
    super(provider.getNetwork())
    this.entryPoint = EntryPoint__factory.connect(entryPointAddress, provider)
  }
}

/**
 * a signer that wraps account-abstraction.
 */
export class AASigner extends Signer {
  _wallet?: SimpleWallet

  private _isPhantom = true
  public entryPoint: EntryPoint

  private _chainId: Promise<number> | undefined

  /**
   * create account abstraction signer
   * @param signer - the underlying signer. has no funds (=can't send TXs)
   * @param entryPoint the entryPoint contract. used for read-only operations
   * @param sendUserOp function to actually send the UserOp to the entryPoint.
   * @param index - index of this wallet for this signer.
   */
  constructor (readonly signer: Signer, readonly entryPointAddress: string, readonly sendUserOp: SendUserOp, readonly index = 0, readonly provider = signer.provider) {
    super()
    this.entryPoint = EntryPoint__factory.connect(entryPointAddress, signer)
    console.log(' AASigner Constructor')
  }

  // connect to a specific pre-deployed address
  // (note: in order to send transactions, the underlying signer address must be valid signer for this wallet (its owner)
  async connectWalletAddress (address: string): Promise<void> {
    console.log(' connectWalletAddress ')
    if (this._wallet != null) {
      throw Error('already connected to wallet')
    }
    if (await this.provider!.getCode(address).then(code => code.length) <= 2) {
      throw new Error('cannot connect to non-existing contract')
    }
    this._wallet = SimpleWallet__factory.connect(address, this.signer)
    this._isPhantom = false
  }

  connect (provider: Provider): Signer {
    throw new Error('connect not implemented')
  }

  async _deploymentAddress (): Promise<string> {
    console.log('query for _deploymentAddress')
    return getCreate2Address(Create2Factory.contractAddress, HashZero, keccak256(await this._deploymentTransaction()))
  }

  async _deploymentTransaction (): Promise<BytesLike> {
    console.log('query for _deploymentTransaction')
    const ownerAddress = await this.signer.getAddress()
    console.log('ownerAddress ', ownerAddress)
    console.log('entry point address ', this.entryPoint.address)
    return new SimpleWallet__factory(this.signer)
      .getDeployTransaction(this.entryPoint.address, ownerAddress).data!
  }

  async getAddress (): Promise<string> {
    console.log('query for getAddress')
    await this.syncAccount()
    return this._wallet!.address
  }

  async signMessage (message: Bytes | string): Promise<string> {
    console.log('signMessage')
    throw new Error('signMessage: unsupported by AA')
  }

  async signTransaction (transaction: Deferrable<TransactionRequest>): Promise<string> {
    console.log('signTransaction')
    throw new Error('signMessage: unsupported by AA')
  }

  async getWallet (): Promise<SimpleWallet> {
    console.log('getWallet')
    await this.syncAccount()
    return this._wallet!
  }

  // fabricate a response in a format usable by ethers users...
  async userEventResponse (userOp: UserOperation): Promise<TransactionResponse> {
    console.log('userEventResponse initiated')

    const entryPoint = this.entryPoint
    const requestId = getRequestId(userOp, entryPoint.address, await this._chainId!)
    const provider = entryPoint.provider
    const currentBLock = provider.getBlockNumber()

    let resolved = false
    const waitPromise = new Promise<TransactionReceipt>((resolve, reject) => {
      let listener = async function (this: any, ...param: any): Promise<void> {
        if (resolved) return
        const event = arguments[arguments.length - 1] as Event
        if (event.blockNumber <= await currentBLock) {
          // not sure why this callback is called first for previously-mined block..
          console.log('ignore previous block', event.blockNumber)
          return
        }
        if (event.args == null) {
          console.error('got event without args', event)
          return
        }
        if (event.args.requestId !== requestId) {
          // eslint-disable-next-line @typescript-eslint/restrict-template-expressions,@typescript-eslint/no-base-to-string
          console.log(`== event with wrong requestId: sender/nonce: event.${event.args.sender}@${event.args.nonce.toString()}!= userOp.${userOp.sender}@${parseInt(userOp.nonce.toString())}`)
          return
        }

        const rcpt = await event.getTransactionReceipt()
        console.log('got event with status=', event.args.success, 'gasUsed=', rcpt.gasUsed)

        // TODO: should use "requestId" as "transactionId" (but this has to be done in a provider, not a signer)

        // before returning the receipt, update the status from the event.
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        if (!event.args.success) {
          console.log('mark tx as failed')
          rcpt.status = 0
          const revertReasonEvents = await entryPoint.queryFilter(entryPoint.filters.UserOperationRevertReason(userOp.sender), rcpt.blockHash)
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
          if (revertReasonEvents[0]) {
            console.log('rejecting with reason')
            reject(new Error(`UserOp failed with reason: ${revertReasonEvents[0].args.revertReason}`)
            )
            return
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        entryPoint.off('UserOperationEvent', listener)
        resolve(rcpt)
        resolved = true
      }
      listener = listener.bind(listener)
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      entryPoint.on('UserOperationEvent', listener)
      // for some reason, 'on' takes at least 2 seconds to be triggered on local network. so add a one-shot timer:
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      setTimeout(async () => await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(requestId)).then(query => {
        if (query.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          listener(query[0])
        }
      }), 500)
    })
    const resp: TransactionResponse = {
      hash: requestId,
      confirmations: 0,
      from: userOp.sender,
      nonce: BigNumber.from(userOp.nonce).toNumber(),
      gasLimit: BigNumber.from(userOp.callGasLimit), // ??
      value: BigNumber.from(0),
      data: hexValue(userOp.callData), // should extract the actual called method from this "execFromSingleton()" call
      chainId: await this._chainId!,
      wait: async function (confirmations?: number): Promise<TransactionReceipt> {
        return await waitPromise
      }
    }
    return resp
  }

  async sendTransaction (transaction: Deferrable<TransactionRequest>): Promise<TransactionResponse> {
    console.log('sendTransaction ')
    const userOp = await this._createUserOperation(transaction)
    // get response BEFORE sending request: the response waits for events, which might be triggered before the actual send returns.
    const reponse = await this.userEventResponse(userOp)
    await this.sendUserOp(userOp)
    return reponse
  }

  async syncAccount (): Promise<void> {
    console.log(' syncAccount ')
    if (this._wallet == null) {
      console.log('getting deployment address under sync account')
      const address = await this._deploymentAddress()
      console.log('address ', address)
      this._wallet = SimpleWallet__factory.connect(address, this.signer)
      // const entryPointView = EntryPoint__factory.connect(this.entryPoint.address, ethersHardhat.provider.getSigner(AddressZero))
      // const getSender = await entryPointView.callStatic.getSenderAddress('0xce0042b868300000d44a59004da54a005ffdcf9f4af63f0200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000141f608060405234801561001057600080fd5b506040516113df3803806113df83398101604081905261002f9161008f565b600180546001600160a01b039384166001600160a01b031990911617905560008054919092166c01000000000000000000000000026001600160601b039091161790556100c9565b6001600160a01b038116811461008c57600080fd5b50565b600080604083850312156100a257600080fd5b82516100ad81610077565b60208401519092506100be81610077565b809150509250929050565b611307806100d86000396000f3fe6080604052600436106100cb5760003560e01c80638da5cb5b11610074578063b0d691fe1161004e578063b0d691fe14610235578063c399ec8814610260578063d0cb75fa1461027557600080fd5b80638da5cb5b14610181578063a9059cbb146101e8578063affed0e01461020857600080fd5b80634a58db19116100a55780634a58db19146101395780634d44560d1461014157806380c5c7d01461016157600080fd5b80630565bb67146100d75780630825d1fc146100f95780631b71bb6e1461011957600080fd5b366100d257005b600080fd5b3480156100e357600080fd5b506100f76100f2366004610f37565b610295565b005b34801561010557600080fd5b506100f7610114366004610fc0565b6102e4565b34801561012557600080fd5b506100f7610134366004611027565b61031f565b6100f7610333565b34801561014d57600080fd5b506100f761015c36600461104b565b6103be565b34801561016d57600080fd5b506100f761017c366004610f37565b61046d565b34801561018d57600080fd5b506000546101be906c01000000000000000000000000900473ffffffffffffffffffffffffffffffffffffffff1681565b60405173ffffffffffffffffffffffffffffffffffffffff90911681526020015b60405180910390f35b3480156101f457600080fd5b506100f761020336600461104b565b610475565b34801561021457600080fd5b506000546bffffffffffffffffffffffff165b6040519081526020016101df565b34801561024157600080fd5b5060015473ffffffffffffffffffffffffffffffffffffffff166101be565b34801561026c57600080fd5b506102276104c5565b34801561028157600080fd5b506100f76102903660046110bc565b61057b565b61029d61069f565b6102de848484848080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201919091525061073c92505050565b50505050565b6102ec6107b9565b6102f784848461083a565b6103046040850185611128565b90506000036103165761031684610977565b6102de81610a3f565b610327610aaa565b61033081610ab2565b50565b600061035460015473ffffffffffffffffffffffffffffffffffffffff1690565b73ffffffffffffffffffffffffffffffffffffffff163460405160006040518083038185875af1925050503d80600081146103ab576040519150601f19603f3d011682016040523d82523d6000602084013e6103b0565b606091505b505090508061033057600080fd5b6103c661069f565b60015473ffffffffffffffffffffffffffffffffffffffff166040517f205c287800000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff848116600483015260248201849052919091169063205c287890604401600060405180830381600087803b15801561045157600080fd5b505af1158015610465573d6000803e3d6000fd5b505050505050565b61029d6107b9565b61047d61069f565b60405173ffffffffffffffffffffffffffffffffffffffff83169082156108fc029083906000818181858888f193505050501580156104c0573d6000803e3d6000fd5b505050565b60006104e660015473ffffffffffffffffffffffffffffffffffffffff1690565b6040517f70a0823100000000000000000000000000000000000000000000000000000000815230600482015273ffffffffffffffffffffffffffffffffffffffff91909116906370a0823190602401602060405180830381865afa158015610552573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610576919061118d565b905090565b61058361069f565b8281146105f1576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601360248201527f77726f6e67206172726179206c656e677468730000000000000000000000000060448201526064015b60405180910390fd5b60005b8381101561069857610686858583818110610611576106116111a6565b90506020020160208101906106269190611027565b600085858581811061063a5761063a6111a6565b905060200281019061064c9190611128565b8080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201919091525061073c92505050565b8061069081611204565b9150506105f4565b5050505050565b6000546c01000000000000000000000000900473ffffffffffffffffffffffffffffffffffffffff163314806106d457503330145b61073a576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152600a60248201527f6f6e6c79206f776e65720000000000000000000000000000000000000000000060448201526064016105e8565b565b6000808473ffffffffffffffffffffffffffffffffffffffff168484604051610765919061123c565b60006040518083038185875af1925050503d80600081146107a2576040519150601f19603f3d011682016040523d82523d6000602084013e6107a7565b606091505b50915091508161069857805160208201fd5b60015473ffffffffffffffffffffffffffffffffffffffff16331461073a576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601b60248201527f77616c6c65743a206e6f742066726f6d20456e747279506f696e74000000000060448201526064016105e8565b6000610893836040517f19457468657265756d205369676e6564204d6573736167653a0a3332000000006020820152603c8101829052600090605c01604051602081830303815290604052805190602001209050919050565b90506108e36108a6610140860186611128565b8080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920191909152508593925050610b409050565b6000546c01000000000000000000000000900473ffffffffffffffffffffffffffffffffffffffff9081169116146102de576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601760248201527f77616c6c65743a2077726f6e67207369676e617475726500000000000000000060448201526064016105e8565b600080546020830135916bffffffffffffffffffffffff909116908061099c83611277565b91906101000a8154816bffffffffffffffffffffffff02191690836bffffffffffffffffffffffff1602179055506bffffffffffffffffffffffff1614610330576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601560248201527f77616c6c65743a20696e76616c6964206e6f6e6365000000000000000000000060448201526064016105e8565b80156103305760405160009033907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff90849084818181858888f193505050503d8060008114610698576040519150601f19603f3d011682016040523d82523d6000602084013e610698565b61073a61069f565b60015460405173ffffffffffffffffffffffffffffffffffffffff8084169216907f450909c1478d09248269d4ad4fa8cba61ca3f50faed58c7aedefa51c7f62b83a90600090a3600180547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff92909216919091179055565b6000806000610b4f8585610b64565b91509150610b5c81610ba9565b509392505050565b6000808251604103610b9a5760208301516040840151606085015160001a610b8e87828585610dfd565b94509450505050610ba2565b506000905060025b9250929050565b6000816004811115610bbd57610bbd6112a2565b03610bc55750565b6001816004811115610bd957610bd96112a2565b03610c40576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601860248201527f45434453413a20696e76616c6964207369676e6174757265000000000000000060448201526064016105e8565b6002816004811115610c5457610c546112a2565b03610cbb576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601f60248201527f45434453413a20696e76616c6964207369676e6174757265206c656e6774680060448201526064016105e8565b6003816004811115610ccf57610ccf6112a2565b03610d5c576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152602260248201527f45434453413a20696e76616c6964207369676e6174757265202773272076616c60448201527f756500000000000000000000000000000000000000000000000000000000000060648201526084016105e8565b6004816004811115610d7057610d706112a2565b03610330576040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152602260248201527f45434453413a20696e76616c6964207369676e6174757265202776272076616c60448201527f756500000000000000000000000000000000000000000000000000000000000060648201526084016105e8565b6000807f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0831115610e345750600090506003610f0c565b8460ff16601b14158015610e4c57508460ff16601c14155b15610e5d5750600090506004610f0c565b6040805160008082526020820180845289905260ff881692820192909252606081018690526080810185905260019060a0016020604051602081039080840390855afa158015610eb1573d6000803e3d6000fd5b50506040517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015191505073ffffffffffffffffffffffffffffffffffffffff8116610f0557600060019250925050610f0c565b9150600090505b94509492505050565b73ffffffffffffffffffffffffffffffffffffffff8116811461033057600080fd5b60008060008060608587031215610f4d57600080fd5b8435610f5881610f15565b935060208501359250604085013567ffffffffffffffff80821115610f7c57600080fd5b818701915087601f830112610f9057600080fd5b813581811115610f9f57600080fd5b886020828501011115610fb157600080fd5b95989497505060200194505050565b60008060008060808587031215610fd657600080fd5b843567ffffffffffffffff811115610fed57600080fd5b8501610160818803121561100057600080fd5b935060208501359250604085013561101781610f15565b9396929550929360600135925050565b60006020828403121561103957600080fd5b813561104481610f15565b9392505050565b6000806040838503121561105e57600080fd5b823561106981610f15565b946020939093013593505050565b60008083601f84011261108957600080fd5b50813567ffffffffffffffff8111156110a157600080fd5b6020830191508360208260051b8501011115610ba257600080fd5b600080600080604085870312156110d257600080fd5b843567ffffffffffffffff808211156110ea57600080fd5b6110f688838901611077565b9096509450602087013591508082111561110f57600080fd5b5061111c87828801611077565b95989497509550505050565b60008083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe184360301811261115d57600080fd5b83018035915067ffffffffffffffff82111561117857600080fd5b602001915036819003821315610ba257600080fd5b60006020828403121561119f57600080fd5b5051919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b60007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203611235576112356111d5565b5060010190565b6000825160005b8181101561125d5760208186018101518583015201611243565b8181111561126c576000828501525b509190910192915050565b60006bffffffffffffffffffffffff808316818103611298576112986111d5565b6001019392505050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052602160045260246000fdfea2646970667358221220f60ebeab6f395f7f55d23c014a99497bede660719add8c7f40df5fe34a18a93464736f6c634300080f00330000000000000000000000002167fa17ba3c80adee05d98f0b55b666be6829d60000000000000000000000002b241cbe6b455e08ade78a7ccc42de2403d7b56600')
      // console.log('getSender from entrypoint ', getSender)
    }

    this._chainId = this.provider?.getNetwork().then(net => net.chainId)
    // once an account is deployed, it can no longer be a phantom.
    // but until then, we need to re-check
    console.log('this._isPhantom ', this._isPhantom)
    if (this._isPhantom) {
      const size = await this.signer.provider?.getCode(this._wallet.address).then(x => x.length)
      // console.log(`== __isPhantom. addr=${this._wallet.address} re-checking code size. result = `, size)
      this._isPhantom = size === 2
      // !await this.entryPoint.isContractDeployed(await this.getAddress());
    }
    console.log('this._isPhantom ', this._isPhantom)
  }

  // return true if wallet not yet created.
  async isPhantom (): Promise<boolean> {
    await this.syncAccount()
    return this._isPhantom
  }

  async _createUserOperation (transaction: Deferrable<TransactionRequest>): Promise<UserOperation> {
    console.log(' _createUserOperation ')
    console.log('tx state ', transaction)
    const tx: TransactionRequest = await resolveProperties(transaction)
    await this.syncAccount()

    let initCode: BytesLike | undefined
    if (this._isPhantom) {
      console.log('ever here??')
      const initCallData = new Create2Factory(this.provider!).getDeployTransactionCallData(hexValue(await this._deploymentTransaction()), HashZero)
      // const deploymentTrx = (await this._deploymentTransaction())
      // console.log(' deploymentTrx ', deploymentTrx);
      // const hex = hexValue(deploymentTrx)
      // console.log(' hex ', hex);
      // const initCallData = new Create2Factory(this.provider!).getDeployTransactionCallData(hex, this.index)

      initCode = hexConcat([
        Create2Factory.contractAddress,
        initCallData
      ])
    }
    const execFromEntryPoint = await this._wallet!.populateTransaction.execFromEntryPoint(tx.to!, tx.value ?? 0, tx.data!)

    let { gasPrice, maxPriorityFeePerGas, maxFeePerGas } = tx
    // gasPrice is legacy, and overrides eip1559 values:
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (gasPrice) {
      maxPriorityFeePerGas = gasPrice
      maxFeePerGas = gasPrice
    }

    const userOp = await fillAndSign({
      sender: this._wallet!.address,
      initCode,
      nonce: initCode == null ? tx.nonce : this.index,
      callData: execFromEntryPoint.data!,
      callGasLimit: tx.gasLimit,
      maxPriorityFeePerGas,
      maxFeePerGas
    }, this.signer, this.entryPoint)
    console.log(' userOp ', userOp)

    return userOp
  }
}
