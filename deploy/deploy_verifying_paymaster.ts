import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { Create2Factory } from '../src/Create2Factory'
import { ethers } from 'hardhat'

const entryPointAddress = '0x2167fA17BA3c80Adee05D98F0B55b666Be6829d6'

const deployPaymaster: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const provider = ethers.provider
  const from = await provider.getSigner().getAddress()
  console.log('from ', from)
  await new Create2Factory(ethers.provider).deployFactory()

  const ret = await hre.deployments.deploy(
    'VerifyingPaymaster', {
      from,
      args: [entryPointAddress, from],
      gasLimit: 4e6,
      deterministicDeployment: false
    })
  console.log('==paymaster addr=', ret.address)
}

export default deployPaymaster
