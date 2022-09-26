import { BigNumberish, Contract, ethers, Signer } from 'ethers'
import { hexlify, hexZeroPad } from 'ethers/lib/utils'
import { Provider } from '@ethersproject/providers'
// import { TransactionRequest } from '@ethersproject/abstract-provider'

const walletFactoryAbi = [{ inputs: [{ internalType: 'address', name: '_baseImpl', type: 'address' }], stateMutability: 'nonpayable', type: 'constructor' }, { anonymous: false, inputs: [{ indexed: true, internalType: 'address', name: '_proxy', type: 'address' }, { indexed: true, internalType: 'address', name: '_implementation', type: 'address' }, { indexed: true, internalType: 'address', name: '_owner', type: 'address' }, { indexed: false, internalType: 'string', name: 'version', type: 'string' }, { indexed: false, internalType: 'uint256', name: '_index', type: 'uint256' }], name: 'WalletCreated', type: 'event' }, { inputs: [], name: 'VERSION', outputs: [{ internalType: 'string', name: '', type: 'string' }], stateMutability: 'view', type: 'function' }, { inputs: [{ internalType: 'address', name: '_owner', type: 'address' }, { internalType: 'address', name: '_entryPoint', type: 'address' }, { internalType: 'address', name: '_handler', type: 'address' }, { internalType: 'uint256', name: '_index', type: 'uint256' }], name: 'deployCounterFactualWallet', outputs: [{ internalType: 'address', name: 'proxy', type: 'address' }], stateMutability: 'nonpayable', type: 'function' }, { inputs: [{ internalType: 'address', name: '_owner', type: 'address' }, { internalType: 'address', name: '_entryPoint', type: 'address' }, { internalType: 'address', name: '_handler', type: 'address' }], name: 'deployWallet', outputs: [{ internalType: 'address', name: 'proxy', type: 'address' }], stateMutability: 'nonpayable', type: 'function' }, { inputs: [{ internalType: 'address', name: '_owner', type: 'address' }, { internalType: 'uint256', name: '_index', type: 'uint256' }], name: 'getAddressForCounterfactualWallet', outputs: [{ internalType: 'address', name: '_wallet', type: 'address' }], stateMutability: 'view', type: 'function' }, { inputs: [{ internalType: 'address', name: '', type: 'address' }], name: 'isWalletExist', outputs: [{ internalType: 'bool', name: '', type: 'bool' }], stateMutability: 'view', type: 'function' }]

export class WalletFactory {
  // @notice this wallet factory currently only works on goerli
  // The address would be same on other networks
  static readonly contractAddress = '0x0d40be078e3910c6a0eef4aecfac9a62fad888e6'
  readonly ethersProvider

  constructor (readonly provider: Provider,
    readonly signer = (provider as ethers.providers.JsonRpcProvider).getSigner()) {
    this.ethersProvider = provider
  }

  getDeployTransactionCallData (owner: string, entryPoint: string, handler: string, index: number): string {
    // these would be deployCounterfactualWallet
    const factory = new Contract(WalletFactory.contractAddress, ['function deployCounterFactualWallet(address _owner, address _entryPoint, address _handler, uint _index) returns(address)'])
    const encodedData = factory.interface.encodeFunctionData('deployCounterFactualWallet', [owner, entryPoint, handler, index])
    return encodedData
  }

  async getCounterFactualAddress (owner: string, index: number): Promise<string> {
    const factory = new Contract(WalletFactory.contractAddress, walletFactoryAbi, this.ethersProvider)
    const addr = await factory.getAddressForCounterfactualWallet(owner, index)
    return addr
  }
}
