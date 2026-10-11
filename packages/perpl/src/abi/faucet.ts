/* Agora testnet AUSD faucet ABI. */
export const agoraFaucetAbi = [
  {
    "type": "function",
    "name": "requestFunds",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "to",
        "type": "address"
      }
    ],
    "outputs": []
  }
] as const;
