async function addAccount(username,password,save=true) {
    window.knownAccounts[username] = password;
    if(save)
        return window.GlobalStorage.put('accounts',username,password);
}
