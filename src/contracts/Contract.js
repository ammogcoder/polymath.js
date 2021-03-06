// @flow

import BigNumber from 'bignumber.js'

import type { NetworkParams, Artifact, Web3Contract, Web3Event, Address, Web3Receipt } from '../../types'

export default class Contract {

  static _params: NetworkParams
  _artifact: Artifact
  _contract: Web3Contract
  _contractWS: Web3Contract
  _methods: Object
  address: Address

  constructor (artifact: Artifact, at?: Address) {
    this._artifact = artifact
    return new Proxy(this, {
      get: (target: Object, field: string): Promise<Web3Receipt> | any => {
        target._init(at)
        if (field in target) {
          return target[field]
        }
        const method = target._contract.methods[field]
        if (!method) {
          return method
        }
        if (this._isView(field)) {
          return (...args) => method(...args).call()
        }
        return (...args) => this._tx(method(...args))
      },
    })
  }

  static setParams (params: NetworkParams) {
    Contract._params = params
  }

  get account (): Address {
    return Contract._params.account
  }

  /** @private */
  _newContract (isWebSockets: boolean = false) {
    return new (isWebSockets
      ? Contract._params.web3WS
      : Contract._params.web3
    ).eth.Contract(this._artifact.abi, this.address)
  }

  /** @private */
  _init (at?: Address) {
    try {
      const address = at || this._artifact.networks[Contract._params.id].address
      if (this._contract && this.address === address) {
        return
      }
      this.address = address
    } catch (e) {
      throw new Error('Contract is not deployed to the network ' + Contract._params.id)
    }
    this._contract = this._newContract()
    this._contractWS = Contract._params.web3WS === Contract._params.web3 ? this._contract : this._newContract(true)
    // noinspection JSUnresolvedVariable
    this._methods = this._contract.methods
  }

  /**
   * Checks whether a contract function is constant (view) or not.
   * @param name
   * @returns {boolean}
   * @private
   */
  _isView (name: string): boolean {
    for (let i = 0; i < this._artifact.abi.length; i++) {
      const method = this._artifact.abi[i]
      if (method.name === name) {
        // noinspection JSUnresolvedVariable
        return method.stateMutability === 'view'
      }
    }
    return false
  }

  /**
   * Checks whether a contract function has boolean output or not.
   * @param name
   * @returns {boolean}
   * @private
   */
  _isBoolOutput (name: string): boolean {
    for (let i = 0; i < this._artifact.abi.length; i++) {
      const method = this._artifact.abi[i]
      if (method.name === name) {
        if (!method.outputs.length) {
          return false
        }
        return (
          method.outputs[0].name === '' && method.outputs[0].type === 'bool'
        )
      }
    }
    throw new Error(`_isBoolOutput: no method with name "${name}" found`)
  }

  /**
   * @param method
   * @param value ETH
   * @returns {Promise.<Web3Receipt>}
   * @protected
   */
  async _tx (method: Object, value?: BigNumber): Promise<Web3Receipt> {
    const preParams = {
      from: this.account,
      value: value ? this._toWei(value) : undefined
    }
    const params = {
      ...preParams,
      gas: Math.floor(await method.estimateGas(preParams) * 2) // TODO @bshevchenko: https://github.com/PolymathNetwork/polymath.js/issues/4
    }

    // dry run
    try {
      const okCode = this._isBoolOutput(method._method.name)
      const dryResult = await method.call(params)
      if (okCode && dryResult !== okCode) {
        throw new Error(`Expected ${okCode === true ? 'true' : okCode}, but received ${dryResult}`)
      }
    } catch (e) {
      throw new Error(`Transaction dry run failed: ${e.message}`)
    }

    const receipt = await method.send(params, (error, hash) => {
      if (!error) {
        Contract._params.txHashCallback(hash)
      }
    })
    Contract._params.txEndCallback(receipt)

    if (receipt.status === '0x0') {
      throw new Error('Transaction failed')
    }

    return receipt
  }

  async subscribe (
    eventName: string,
    filter: Object,
    callback: (event: Web3Event) => void,
  ): Promise<boolean> {
    try {
      await this._contractWS.events[eventName](
        { filter },
        (error, event) => {
          if (error) {
            // eslint-disable-next-line
            console.error(`Event "${eventName}" subscription error`, error)
            return
          }
          // eslint-disable-next-line
          console.log(`Emitted ${eventName} event`, event)
          callback(event)
        },
      )
      return true
    } catch (e) {
      // eslint-disable-next-line
      console.error(`Event "${eventName}" subscription failed`, e)
      return false
    }
  }

  static unsubscribe (): boolean {
    try {
      Contract._params.web3WS.eth.clearSubscriptions()
    } catch (e) {
      // TODO @bshevchenko: clearSubscriptions throws error when no subscriptions and probably subscriptions are not tracked at all
    }
    return true
  }

  /**
   * @param v
   * @returns {string}
   * @protected
   */
  _toBytes (v: string): string {
    return Contract._params.web3.utils.asciiToHex(v)
  }

  /**
   * @param v
   * @returns {string}
   * @protected
   */
  _toAscii (v: string): string {
    return Contract._params.web3.utils.hexToAscii(v).replace(/\u0000/g, '')
  }

  /**
   * @param v
   * @returns {number}
   * @protected
   */
  _toUnixTS (v: Date | 0): number {
    return v === 0 ? 0 : Math.floor(v.getTime() / 1000)
  }

  /**
   * @param v
   * @returns {Date}
   * @protected
   */
  _toDate (v: number): Date {
    return new Date(v * 1000)
  }

  /**
   * For destructuring Solidity array outputs.
   * @param v
   * @returns {Array<any>}
   * @protected
   */
  _toArray (v: Object): Array<any> {
    const result: Array<any> = []
    for (let key of Object.keys(v)) {
      result.push(v[key])
    }
    return result
  }

  /**
   * @param v
   * @param unit
   * @returns {BigNumber}
   * @protected
   */
  _toWei (v: BigNumber, unit: string = 'ether'): BigNumber {
    return new BigNumber(Contract._params.web3.utils.toWei(v, unit))
  }

  /**
   * @param v
   * @param unit
   * @returns {BigNumber}
   * @protected
   */
  _fromWei (v: BigNumber, unit: string = 'ether'): BigNumber {
    return new BigNumber(Contract._params.web3.utils.fromWei(v, unit))
  }

  /**
   * @param v
   * @returns {boolean}
   * @protected
   */
  _isEmptyAddress (v: Address | string): boolean {
    return v === '0x0000000000000000000000000000000000000000'
  }
}
