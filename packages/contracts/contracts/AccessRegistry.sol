// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Binds an opaque identity handle to a smart account.
 *
 * What is deliberately NOT here: no name, no contact, no face, no hash of a
 * face. `identityId` is a random 128-bit handle that carries no information —
 * the chain learns that some pseudonym controls some account, and nothing else.
 *
 * That is what makes an erasure request satisfiable against a permanent ledger:
 * delete the off-chain mapping and these rows point at nobody. Any design that
 * anchors biometric material here forfeits that on day one, for every user.
 */
contract AccessRegistry {
    error NotRegistrar();
    error AlreadyBound(bytes32 identityId);
    error AccountInUse(address account);
    error NotBound(bytes32 identityId);
    error ZeroAccount();

    event RegistrarChanged(address indexed registrar, bool allowed);
    event Bound(bytes32 indexed identityId, address indexed account);
    event Rebound(bytes32 indexed identityId, address indexed from, address indexed to);
    event Unbound(bytes32 indexed identityId, address indexed account);

    address public immutable admin;
    mapping(address => bool) public isRegistrar;

    mapping(bytes32 => address) private _accountOf;
    mapping(address => bytes32) private _identityOf;

    modifier onlyRegistrar() {
        if (!isRegistrar[msg.sender]) revert NotRegistrar();
        _;
    }

    constructor(address registrar) {
        admin = msg.sender;
        isRegistrar[registrar] = true;
        emit RegistrarChanged(registrar, true);
    }

    function setRegistrar(address registrar, bool allowed) external {
        if (msg.sender != admin) revert NotRegistrar();
        isRegistrar[registrar] = allowed;
        emit RegistrarChanged(registrar, allowed);
    }

    function bind(bytes32 identityId, address account) external onlyRegistrar {
        if (account == address(0)) revert ZeroAccount();
        if (_accountOf[identityId] != address(0)) revert AlreadyBound(identityId);
        // One account per identity, both ways. Without the reverse check, two
        // pseudonyms can share an account and the per-identity purchase cap
        // becomes a per-wallet cap, which is exactly what a farm wants.
        if (_identityOf[account] != bytes32(0)) revert AccountInUse(account);

        _accountOf[identityId] = account;
        _identityOf[account] = identityId;
        emit Bound(identityId, account);
    }

    /**
     * Recovery after a lost device.
     *
     * A fan who loses their phone must not lose their tickets, so the binding
     * has to be movable. It is gated to the registrar, which off-chain means a
     * re-verification against the vault before this is ever called.
     */
    function rebind(bytes32 identityId, address newAccount) external onlyRegistrar {
        if (newAccount == address(0)) revert ZeroAccount();
        address current = _accountOf[identityId];
        if (current == address(0)) revert NotBound(identityId);
        if (_identityOf[newAccount] != bytes32(0)) revert AccountInUse(newAccount);

        delete _identityOf[current];
        _accountOf[identityId] = newAccount;
        _identityOf[newAccount] = identityId;
        emit Rebound(identityId, current, newAccount);
    }

    /** Used when consent is withdrawn: the pseudonym stops resolving to anything. */
    function unbind(bytes32 identityId) external onlyRegistrar {
        address current = _accountOf[identityId];
        if (current == address(0)) revert NotBound(identityId);
        delete _identityOf[current];
        delete _accountOf[identityId];
        emit Unbound(identityId, current);
    }

    function accountOf(bytes32 identityId) external view returns (address) {
        return _accountOf[identityId];
    }

    function identityOf(address account) external view returns (bytes32) {
        return _identityOf[account];
    }

    function isBound(bytes32 identityId) external view returns (bool) {
        return _accountOf[identityId] != address(0);
    }
}
