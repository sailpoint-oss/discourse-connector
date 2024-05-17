import { ConnectorError, StdAccountDeleteOutput, StdTestConnectionOutput } from "@sailpoint/connector-sdk"
import { User } from "./model/user"
import { Group } from "./model/group"
import { GroupListResponse } from "./model/group-list-response"
import { GroupResponse } from "./model/group-response"
import { GroupMembers } from "./model/group-members"
import { UserEmail } from "./model/user-email"
import { UserUpdateResponse } from "./model/user-update-response"
import { UserUpdate } from "./model/user-update"
import { UserUsernameResponse } from "./model/user-username-response"
import { Config } from "./model/config"
import { HTTP } from "./http/http"
import { HTTPFactory } from "./http/http-factory"
import crypto from "crypto"
import FormData from "form-data"
import { AxiosError } from "axios"
import { InvalidConfigurationError } from "./errors/invalid-configuration-error"

/**
 * DiscourseClient is the client that communicates with Discourse APIs.
 */
export class DiscourseClient {
    private readonly apiKey?: string
    private readonly apiUsername?: string
    private readonly baseUrl?: string
    private readonly primaryGroup: string
    private readonly employeeIdFieldId: string
    httpClient: HTTP;

    constructor(config: Config) {
        // Fetch necessary properties from config.
        this.apiKey = config.apiKey
        if (this.apiKey == null) {
            throw new InvalidConfigurationError('apiKey must be provided from config')
        }

        this.apiUsername = config.apiUsername
        if (this.apiUsername == null) {
            throw new InvalidConfigurationError('apiUsername must be provided from config')
        }

        this.baseUrl = config.baseUrl
        if (this.baseUrl == null) {
            throw new InvalidConfigurationError('baseUrl must be provided from config')
        }

        if (config.primaryGroup == undefined) {
            throw new InvalidConfigurationError('primaryGroup must be provided from config')
        } else {
            this.primaryGroup = config.primaryGroup
        }

        if (config.employeeIdFieldId == undefined) {
            throw new InvalidConfigurationError('employeeIdFieldId must be provided from config')
        } else {
            this.employeeIdFieldId = config.employeeIdFieldId
        }

        this.httpClient = HTTPFactory.getHTTP(config);
    }

    /**
     * Test connection by listing users from the Discourse instance.  
     * This will make sure the apiKey has the correct access.
     * @returns empty struct if response is 2XX
     */
    async testConnection(): Promise<StdTestConnectionOutput> {
        const staffList = await this.httpClient.get<User[]>('/admin/users/list/staff.json')
        if (staffList.status !== 200) {
            throw new ConnectorError("Unable to connect to Discourse")
        }
        return {}
    }

    /**
     * Create a user.
     * @param user the user to be created.
     * @returns the user.
     */
    async createUser(user: User): Promise<User> {
        await this.httpClient.post<void>('/users.json', {
            name: user.name, // name doesn't work in discourse, so just use username
            email: user.email,
            password: user.password != null ? user.password : this.generateRandomPassword(),
            username: user.username,
            active: true,
            user_fields: user.user_fields,
            approved: true
        }).catch((error: unknown) => {
            throw new ConnectorError(`Failed to create user ${user.username}: ${error}`)
        })

        const createdUser = await this.getUserByUsername(user.username)

        const updateData = new UserUpdate()
        updateData.groups = createdUser.groups // Populate udpateData with default groups assigned to new users
        // If the provisioning plan includes groups, add them to the update data.
        if (user.groups != null && updateData.groups != null) {
            updateData.groups = updateData.groups.concat(user.groups)
        }
        if (user.title != null) {
            updateData.title = user.title
        }

        return await this.updateUser(createdUser, updateData, user.username)
    }

    /**
    * Generates a password of 20 characters using the crypto package
    * @returns {string} the random password.
    */
    private generateRandomPassword(): string {
        return crypto.randomBytes(20).toString('hex');
    }

    /**
     * Delete a user by identity.
     * @param identity the id of the user.
     * @returns empty struct if response is 2XX
     */
    async deleteUser(identity: string): Promise<StdAccountDeleteOutput> {
        await this.httpClient.delete(`/admin/users/${identity}.json`)
        return {}
    }

    /**
    * Gets users from the discourse system
    * @returns {Promise<User[]>} the users.
    */
    async getUsers(offset: number, limit: number): Promise<User[]> {
        // First, get the members of the group.  This will return a subset of the fields we need to complete a user.
        const groupMembers = await this.getGroupMembers(this.primaryGroup, offset, limit)

        // Get the full user representation.
        const users = await Promise.all(groupMembers.map(member => this.getUser(member.id.toString())))


        return users
    }

    private async getGroupMembers(groupname: string, offset: number, limit: number): Promise<User[]> {
        let members: User[] = []

        const response = await this.httpClient.get<GroupMembers>(`/groups/${groupname}/members.json`, {
            params: {
                offset: offset,
                limit: limit
            }
        }).catch((error: unknown) => {
            throw new ConnectorError(`Failed to retrieve members for group ${groupname}: ${error}`)
        })

        members = members.concat(response.data.members);
        offset += limit

        return members
    }

    private async getUserEmailAddress(username?: string): Promise<string> {
        const response = await this.httpClient.get<UserEmail>(`/u/${username}/emails.json`).catch((error: unknown) => {
            throw new ConnectorError(`Failed to retrieve email for user ${username}: ${error}`)
        })

        return response.data.email
    }

    private async addUserToGroup(groupId?: number, username?: string): Promise<boolean> {
        await this.httpClient.put<void>(`/groups/${groupId}/members.json`, {
            usernames: username
        }).catch((error: AxiosError) => {
            if (error.response && error.response.status !== 422) {
                throw new ConnectorError(error.message)
            }
        })

        return true
    }

    public async suspendUser(userId?: string): Promise<boolean> {
        await this.httpClient.put<void>(`/admin/users/${userId}/suspend.json`, {
            suspend_until: '9999-01-01',
            reason: 'User is disabled in SailPoint IdentityNow'
        }).catch((error: AxiosError) => {
            if (error.response && error.response.status !== 422) {
                throw new ConnectorError(error.message)
            }
        })
        return true
    }

    public async revokeAdmin(userId?: string): Promise<boolean> {
        await this.httpClient.put<void>(`/admin/users/${userId}/revoke_admin.json`, {
        }).catch((error: AxiosError) => {
            if (error.response && error.response.status !== 422) {
                throw new ConnectorError(error.message)
            }
        })
        return true
    }

    public async grantAdmin(userId?: string): Promise<boolean> {
        await this.httpClient.put<void>(`/admin/users/${userId}/grant_admin.json`, {
        }).catch((error: AxiosError) => {
            if (error.response && error.response.status !== 422) {
                throw new ConnectorError(error.message)
            }
        })
        return true
    }

    public async revokeModerator(userId?: string): Promise<boolean> {
        await this.httpClient.put<void>(`/admin/users/${userId}/revoke_moderation.json`, {
        }).catch((error: AxiosError) => {
            if (error.response && error.response.status !== 422) {
                throw new ConnectorError(error.message)
            }
        })
        return true
    }

    public async grantModerator(userId?: string): Promise<boolean> {
        await this.httpClient.put<void>(`/admin/users/${userId}/grant_moderation.json`, {
        }).catch((error: AxiosError) => {
            if (error.response && error.response.status !== 422) {
                throw new ConnectorError(error.message)
            }
        })
        return true
    }

    public async unsuspendUser(userId?: string): Promise<boolean> {
        await this.httpClient.put<void>(`/admin/users/${userId}/unsuspend.json`, {
        }).catch((error: AxiosError) => {
            if (error.response && error.response.status !== 422) {
                throw new ConnectorError(error.message)
            }
        })
        return true
    }

    public async forgotPassword(username?: string): Promise<boolean> {
        await this.httpClient.put<void>(`/session/forgot_password.json`, {
            login: username
        }).catch((error: AxiosError) => {
            if (error.response && error.response.status !== 422) {
                throw new ConnectorError(error.message)
            }
        })
        return true
    }


    private async removeUserFromGroup(userId: string, groupId?: number): Promise<boolean> {
        await this.httpClient.delete<void>(`/admin/users/${userId}/groups/${groupId}`)
            .catch((error: AxiosError) => {
                if (error.response && error.response.status !== 422) {
                    throw new ConnectorError(error.message)
                }
            })

        return true
    }

    async updateUserEmail(userId: string, email: string): Promise<boolean> {
        const data = { email: email};
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
        await this.httpClient.putFormData<void>(`/u/${userId}/preferences/email`, data, headers);
        return true
    }

    /**
     * update a user by username.
     * @param username the username of the user.
     * @param origUser the original user before the update.
     * @param newUser the user data to be updated.
     * @returns the updated user.
     */
    async updateUser(origUser: User, newUser: User, username?: string): Promise<User> {
        const userUpdate = UserUpdate.fromUser(newUser)

        const response = await this.httpClient.put<UserUpdateResponse>(`/u/${username}.json`, userUpdate)
        if (response.data.user == null) {
            throw new ConnectorError('Failed to update user.')
        }

        if(origUser.email != newUser.email && newUser.email && origUser.username) {
            await this.updateUserEmail(origUser.username, newUser.email)
        }

        // If requested "staff" group then remove, not valid
        origUser.groups = origUser.groups?.filter(group => {return group.name != 'staff' ? true : false })
        // Remove any groups that are not contained in the userUpdate object
        const origUserGroupIds = origUser.groups?.map(group => { return group.id })
        // Remove staff as it is not a valid group to add
        userUpdate.groups = userUpdate.groups?.filter(group => {return group.name != 'staff' ? true : false })
        

        // check for moderator group id
        const moderatorGroup = userUpdate.groups?.filter(group => {return group.name == 'moderators' ? true : false })
        const moderatorGroup2 = origUser.groups?.filter(group => {return group.name == 'moderators' ? true : false })
        let moderatorId = -1
        if (moderatorGroup && moderatorGroup.length > 0) {
            moderatorId = moderatorGroup[0].id
        }
        if (moderatorGroup2 && moderatorGroup2.length > 0) {
            moderatorId = moderatorGroup2[0].id
        }

        // check for admin group id
        const adminGroup = userUpdate.groups?.filter(group => {return group.name == 'admins' ? true : false })
        const adminGroup2 = origUser.groups?.filter(group => {return group.name == 'admins' ? true : false })
        let adminId = -1
        if (adminGroup && adminGroup.length > 0) {
            adminId = adminGroup[0].id
        }
        if (adminGroup2 && adminGroup2.length > 0) {
            adminId = adminGroup2[0].id
        }

        const userUpdateGroupIds = userUpdate.groups?.map(group => { return group.id })
        if (origUserGroupIds && userUpdateGroupIds) {
            const groupsToRemove = origUserGroupIds.filter(x => !userUpdateGroupIds.includes(x))
            if (groupsToRemove != null && groupsToRemove.length > 0) {
                for (const group of groupsToRemove) {
                    if (group == moderatorId) {
                        await this.revokeModerator(origUser.id.toString())
                    } else if (group == adminId) {
                        await this.revokeAdmin(origUser.id.toString())
                    } else {
                        await this.removeUserFromGroup(origUser.id.toString(), group)
                    } 
                }
            }

            // Add any groups that are not contained in the origUser object
            const groupsToAdd = userUpdateGroupIds.filter(x => !origUserGroupIds.includes(x))
            if (groupsToAdd != null && groupsToAdd.length > 0) {
                for (const group of groupsToAdd) {
                    if (group == moderatorId) {
                        await this.grantModerator(origUser.id.toString())
                    } else if (group == adminId) {
                        await this.grantAdmin(origUser.id.toString())
                    } else {
                        await this.addUserToGroup(group, username)
                    } 
                }
            }

        }

        return await this.getUser(origUser.id.toString())
    }

    /**
     * Retrieve a single user by identity.
     * @param identity the numeric ID of the user represented as a string.
     * @returns the user.
     */
    async getUser(identity: string): Promise<User> {
        const userResponse = await this.httpClient.get<User>(`/admin/users/${identity}.json`).catch((error: unknown) => {
            throw new ConnectorError(`Failed to retrieve user ${identity}: Error ${error}`)
        })

        let user = null
        user = userResponse.data
        user.email = await this.getUserEmailAddress(user.username)
        return user
    }

    /**
    * Retrieve a single user by username.
    * @param username the username of the user
    * @returns the user.
    */
    async getUserByUsername(username?: string): Promise<User> {
        const userResponse = await this.httpClient.get<UserUsernameResponse>(`/u/${username}.json`).catch((error: unknown) => {
            throw new ConnectorError(`Failed to retrieve user ${username}: Error ${error}`)
        })

        let user = null
        user = userResponse.data.user
        user.email = await this.getUserEmailAddress(user.username)
        return user
    }


    /**
     * List groups with pagination
     * @returns a list of groups.
     */
    async getGroups(page: number): Promise<Group[]> {
        let groups: Group[] = []
        const response = await this.httpClient.get<GroupListResponse>('/groups.json', {
            params: {
                page: page
            }
        }).catch(() => {
            throw new ConnectorError('Failed to retrieve list of groups')
        })

        groups = groups.concat(response.data.groups);

        return groups
    }

    /**
     * Get a single group by ID.  The ID is the name of the group not the numeric ID.
     * @param name the name of the group
     * @returns a single group.
     */
    async getGroup(name: string): Promise<Group> {
        const response = await this.httpClient.get<GroupResponse>(`/groups/${name}.json`).catch(() => {
            throw new ConnectorError(`Failed to retrieve the ${name} group.`)
        })

        return response.data.group
    }
}
